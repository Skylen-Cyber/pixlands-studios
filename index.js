require("dotenv").config();

const noblox  = require("noblox.js");
const express = require("express");
const axios   = require("axios");
const session = require("express-session");

const rateLimit = require("express-rate-limit");
const path    = require("path");
const fs      = require("fs");
const cfg     = require("./config");

const app = express();
const IS_PROD = process.env.NODE_ENV === "production";

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  
  secret: cfg.SESSION_SECRET || "fallback-secret",
  resave: false,
  saveUninitialized: false,
  cookie: { secure: IS_PROD, httpOnly: true, sameSite: "lax", maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

// Genel API rate limit — 15 dakikada 100 istek
app.use("/api/", rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Çok fazla istek gönderdiniz. Lütfen bekleyin." }
}));

// Rank işlemi için ekstra sıkı limit — 1 dakikada 5 istek
// Genel API rate limit — tüm /api istekleri için
app.use("/api", rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: "Çok fazla istek. Lütfen bekleyin." },
  standardHeaders: true,
  legacyHeaders: false,
}));

// Korumalı /api rotalar için auth middleware
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "Oturum açmanız gerekiyor." });
  next();
}

app.use("/api/rank-action", rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: "Çok fazla rütbe işlemi. Lütfen bekleyin." }
}));

let BOT_ID = null;

/* ── SUNUCU TARAFLI COOLDOWN'LAR ── */
const rankCooldowns   = new Map(); // discordId -> timestamp
const rowifiCooldowns = new Map(); // discordId -> timestamp
const RANK_COOLDOWN_MS   = 30 * 1000;
const ROWIFI_COOLDOWN_MS = 15 * 1000;

const DB_FILE = "./data.json";

/* ── JSON DB YARDIMCILARI ── */
function dbRead() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch(e) { return {}; }
}
function dbWrite(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), "utf8");
}
function dbGet(keyPath) {
  const keys = keyPath.split(".");
  let cur = dbRead();
  for (const k of keys) { if (cur == null) return null; cur = cur[k]; }
  return cur ?? null;
}
function dbSet(keyPath, value) {
  const data = dbRead();
  const keys = keyPath.split(".");
  let cur = data;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]] || typeof cur[keys[i]] !== "object") cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
  dbWrite(data);
}
function dbIncr(keyPath) {
  const cur = parseInt(dbGet(keyPath)) || 0;
  dbSet(keyPath, cur + 1);
  return cur + 1;
}

/* ── BOT GİRİŞ ── */
(async () => {
  try {
    await noblox.setCookie(cfg.ROBLOX_COOKIE);
    const BOT = await noblox.getAuthenticatedUser();
    BOT_ID = BOT.id;
    console.log(`[OK] Bot: ${BOT.name} (ID: ${BOT.id})`);
  } catch (e) {
    console.error("[HATA] Bot giriş başarısız:", e.message);
  }
})();

/* ── YARDIMCI: Discord kullanıcı bilgisi ── */
async function fetchDiscordUser(id) {
  const r = await axios.get(`https://discord.com/api/users/${id}`, {
    headers: { Authorization: `Bot ${cfg.DISCORD_BOT_TOKEN}`, "User-Agent": "DiscordBot (https://pixlands.onrender.com, 1.0)" }
  });
  return r.data;
}

/* ── YARDIMCI: Webhook log ── */
async function sendWebhookLog(webhookUrl, opts) {
  if (!webhookUrl) return;
  try {
    const { issuerDiscord, issuerRoblox, issuerRobloxId, targetRoblox, targetRobloxId, action, oldRole, newRole, groupName } = opts;
    const actionLabel = action === "promote" ? "Rütbe Terfileme" : action === "demote" ? "Rütbe Tenzilleme" : "Rütbe Değiştirme";
    await axios.post(webhookUrl, { embeds: [{ title: `${actionLabel} İşlemi — ${groupName}`, color: action === "promote" ? 0x4ade80 : action === "demote" ? 0xf87171 : 0x60a5fa, fields: [{ name: "İşlemi Yapan", value: `**${issuerDiscord}**\n[${issuerRoblox}](https://www.roblox.com/users/${issuerRobloxId}/profile)`, inline: true }, { name: "Hedef Kullanıcı", value: `[${targetRoblox}](https://www.roblox.com/users/${targetRobloxId}/profile)\n${oldRole} → **${newRole}**`, inline: true }], thumbnail: { url: `https://www.roblox.com/headshot-thumbnail/image?userId=${issuerRobloxId}&width=100&height=100&format=png` }, timestamp: new Date().toISOString() }] });
  } catch(e) { console.error("[Webhook]", e.message); }
}

/* ── YARDIMCI: Ekipte mi? ── */
function isTeamMember(discordId) {
  return cfg.TEAM.some(m => m.discordId === String(discordId));
}

/* ── YARDIMCI: Sayı formatlama ── */
function formatCount(n) {
  if (n >= 1000000) return Math.floor(n / 1000000) + "M+";
  if (n >= 1000) return Math.floor(n / 1000) + "K+";
  return String(n);
}

/* ════════════════════════════════════════
   CONFIG endpoint
════════════════════════════════════════ */
app.get("/api/config", (req, res) => {
  res.json({
    siteName: cfg.SITE_NAME,
    guildInvite: cfg.DISCORD_GUILD_INVITE,
    gamesCount: (cfg.GAMES || []).length,
  });
});

/* ════════════════════════════════════════
   EKİP endpoint
════════════════════════════════════════ */
app.get("/api/team", async (req, res) => {
  try {
    const sorted = [...cfg.TEAM].sort((a, b) => a.sira - b.sira);
    const members = await Promise.all(sorted.map(async (m) => {
      try {
        const u = await fetchDiscordUser(m.discordId);
        const avatar = u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128` : `https://cdn.discordapp.com/embed/avatars/0.png`;
        return { sira: m.sira, tur: m.tur, username: u.username, displayName: u.global_name || u.username, avatar, id: u.id, description: m.description || "" };
      } catch(e) {
        return { sira: m.sira, tur: m.tur, username: "Bilinmiyor", displayName: "Bilinmiyor", avatar: "", id: m.discordId, description: "" };
      }
    }));
    res.json({ members });
  } catch(e) { res.status(500).json({ error: "Ekip bilgisi alınamadı." }); }
});

/* ════════════════════════════════════════
   DISCORD AUTH
════════════════════════════════════════ */
app.get("/auth/discord", (req, res) => {
  const params = new URLSearchParams({ client_id: cfg.DISCORD_CLIENT_ID, redirect_uri: cfg.DISCORD_REDIRECT_URI, response_type: "code", scope: "identify guilds" });
  res.redirect(`https://discord.com/oauth2/authorize?${params.toString()}`);
});

app.get("/auth/discord/callback", async (req, res) => {
  const code = req.query.code;
  if (!code) return res.redirect("/?error=no_code");
  try {
    const tokenRes = await axios.post("https://discord.com/api/oauth2/token", new URLSearchParams({
      client_id: cfg.DISCORD_CLIENT_ID, client_secret: cfg.DISCORD_CLIENT_SECRET,
      grant_type: "authorization_code", code, redirect_uri: cfg.DISCORD_REDIRECT_URI,
    }), { headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "DiscordBot (https://pixlands.onrender.com, 1.0)" } });

    const { access_token, token_type } = tokenRes.data;
    const userRes = await axios.get("https://discord.com/api/users/@me", { headers: { Authorization: `${token_type} ${access_token}`, "User-Agent": "DiscordBot (https://pixlands.onrender.com, 1.0)" } });
    const user = userRes.data;

    let in_guild = false;
    try {
      const gr = await axios.get("https://discord.com/api/users/@me/guilds", { headers: { Authorization: `${token_type} ${access_token}`, "User-Agent": "DiscordBot (https://pixlands.onrender.com, 1.0)" } });
      in_guild = gr.data.some(g => g.id === cfg.DISCORD_GUILD_ID);
    } catch(e) {}

    let roblox_username = null, roblox_id = null;
    if (cfg.ROWIFI_API_KEY) {
      try {
        const rw = await axios.get(`https://api.rowifi.xyz/v3/guilds/${cfg.DISCORD_GUILD_ID}/members/${user.id}`, { headers: { Authorization: `Bot ${cfg.ROWIFI_API_KEY}` } });
        if (rw.data && rw.data.roblox_id) {
          roblox_id = rw.data.roblox_id;
          roblox_username = await noblox.getUsernameFromId(roblox_id);
        }
      } catch(e) {}
    }

    req.session.user = { id: user.id, username: user.username, avatar: user.avatar, access_token, token_type, in_guild, roblox_username, roblox_id };

    // CroxyDB: üye sayısını artır (aynı ID'den tekrar giriş yapılınca artmasın)
    if (true) {
      const alreadyCounted = dbGet(`profiles.${user.id}.counted`);
      if (!alreadyCounted) {
        dbIncr("stats.member_count");
        dbSet(`profiles.${user.id}.counted`, "1");
      }
      // Profil verisini kaydet/güncelle
      dbSet(`profiles.${user.id}.data`, {
        id: user.id, username: user.username, avatar: user.avatar,
        roblox_username, roblox_id, in_guild,
        updatedAt: Date.now()
      });
    }

    res.redirect("/?loggedin=1");
  } catch (e) {
    console.error("[HATA] OAuth:", e.response?.data || e.message);
    res.redirect("/?error=oauth_failed");
  }
});

app.get("/auth/me", (req, res) => {
  if (req.session.user) res.json({ loggedIn: true, user: req.session.user });
  else res.json({ loggedIn: false });
});

app.post("/auth/logout", async (req, res) => {
  const u = req.session.user;
  if (u?.access_token) {
    try {
      await axios.post("https://discord.com/api/oauth2/token/revoke", new URLSearchParams({ client_id: cfg.DISCORD_CLIENT_ID, client_secret: cfg.DISCORD_CLIENT_SECRET, token: u.access_token }), { headers: { "Content-Type": "application/x-www-form-urlencoded" } });
    } catch(e) {}
  }
  req.session.destroy();
  res.json({ success: true });
});

/* ── SYNC ── */
app.post("/auth/sync", async (req, res) => {
  if (!req.session.user) return res.json({ ok: false });
  const u = req.session.user;
  try {
    const gr = await axios.get("https://discord.com/api/users/@me/guilds", { headers: { Authorization: `${u.token_type} ${u.access_token}`, "User-Agent": "DiscordBot (https://pixlands.onrender.com, 1.0)" } });
    u.in_guild = gr.data.some(g => g.id === cfg.DISCORD_GUILD_ID);
  } catch(e) {}
  if (u.in_guild && cfg.ROWIFI_API_KEY && !u.roblox_id) {
    try {
      const rw = await axios.get(`https://api.rowifi.xyz/v3/guilds/${cfg.DISCORD_GUILD_ID}/members/${u.id}`, { headers: { Authorization: `Bot ${cfg.ROWIFI_API_KEY}` } });
      if (rw.data?.roblox_id) { u.roblox_id = rw.data.roblox_id; u.roblox_username = await noblox.getUsernameFromId(u.roblox_id); }
    } catch(e) {}
  }
  res.json({ ok: true, user: u });
});

/* ── ROWIFI YENİLE ── */
app.post("/auth/refresh-rowifi", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Oturum açın." });
  const uid = req.session.user.id;
  const lastRefresh = rowifiCooldowns.get(uid) || 0;
  const remaining = ROWIFI_COOLDOWN_MS - (Date.now() - lastRefresh);
  if (remaining > 0) return res.status(429).json({ error: `Lütfen ${Math.ceil(remaining / 1000)} saniye bekleyin.`, retryAfter: Math.ceil(remaining / 1000) });
  rowifiCooldowns.set(uid, Date.now());
  try {
    const rw = await axios.get(`https://api.rowifi.xyz/v3/guilds/${cfg.DISCORD_GUILD_ID}/members/${req.session.user.id}`, { headers: { Authorization: `Bot ${cfg.ROWIFI_API_KEY}` } });
    const data = rw.data;
    if (!data?.roblox_id) { req.session.user.roblox_username = null; req.session.user.roblox_id = null; return res.json({ changed: true, verified: false }); }
    const name = await noblox.getUsernameFromId(data.roblox_id);
    const changed = name !== req.session.user.roblox_username || String(data.roblox_id) !== String(req.session.user.roblox_id);
    req.session.user.roblox_username = name; req.session.user.roblox_id = data.roblox_id;
    // CroxyDB güncelle
    dbSet(`profiles.${uid}.data`, { id: uid, username: req.session.user.username, avatar: req.session.user.avatar, roblox_username: name, roblox_id: data.roblox_id, in_guild: req.session.user.in_guild, updatedAt: Date.now() });
    res.json({ changed, verified: true, robloxUsername: name, robloxId: data.roblox_id });
  } catch(e) { res.status(500).json({ error: "Rowifi bilgisi alınamadı." }); }
});

/* ── COOLDOWN SORGULA ── */
app.get("/api/cooldown", requireAuth, (req, res) => {
  if (!req.session.user) return res.json({ rank: 0, rowifi: 0 });
  const uid = req.session.user.id;
  const rankLeft   = Math.max(0, RANK_COOLDOWN_MS   - (Date.now() - (rankCooldowns.get(uid)   || 0)));
  const rowifiLeft = Math.max(0, ROWIFI_COOLDOWN_MS - (Date.now() - (rowifiCooldowns.get(uid) || 0)));
  res.json({ rank: Math.ceil(rankLeft / 1000), rowifi: Math.ceil(rowifiLeft / 1000) });
});

/* ════════════════════════════════════════
   GRUPLAR
════════════════════════════════════════ */
app.get("/api/groups", requireAuth, async (req, res) => {
  try {
    const result = await Promise.all(cfg.GROUPS.map(async (g) => {
      try {
        const info = await noblox.getGroup(g.groupId);
        let icon = "";
        try { const thumbs = await noblox.getThumbnails([{ type: "GroupIcon", targetId: g.groupId, size: "420x420" }]); icon = thumbs[0]?.imageUrl || ""; } catch(e) {}
        return { id: g.groupId, name: info.name, icon, minAdminRank: g.minAdminRank || 0 };
      } catch(e) { return { id: g.groupId, name: `Grup ${g.groupId}`, icon: "", minAdminRank: g.minAdminRank || 0 }; }
    }));
    res.json({ groups: result });
  } catch(e) { res.status(500).json({ error: "Gruplar alınamadı." }); }
});

/* ── ROLLER ── */
app.get("/api/grouproles", requireAuth, async (req, res) => {
  const groupId = parseInt(req.query.groupId, 10);
  const forDemote = req.query.demote === "1";
  if (!groupId) return res.status(400).json({ error: "groupId gerekli." });
  if (!BOT_ID) return res.status(503).json({ error: "Bot hazır değil." });
  try {
    const roles = await noblox.getRoles(groupId);
    const botRank = await noblox.getRankInGroup(groupId, BOT_ID);
    let filtered = roles.filter(r => r.rank > 0 && r.rank < 255 && r.rank < botRank);
    if (forDemote && filtered.length > 0) { const minRank = Math.min(...filtered.map(r => r.rank)); filtered = filtered.filter(r => r.rank !== minRank); }
    res.json({ roles: filtered, botRank });
  } catch(e) { res.status(500).json({ error: "Roller alınamadı." }); }
});

/* ── ROBLOX THUMBNAIL ── */
app.get("/api/roblox-thumbnail", requireAuth, async (req, res) => {
  const userId = parseInt(req.query.userId, 10);
  if (!userId) return res.status(400).json({ error: "userId gerekli." });
  try {
    const thumbs = await noblox.getPlayerThumbnail([userId], 420, "png", true, "Headshot");
    res.json({ url: thumbs[0]?.imageUrl || "" });
  } catch(e) { res.status(500).json({ url: "" }); }
});

/* ════════════════════════════════════════
   RANK İŞLEMİ
════════════════════════════════════════ */
app.post("/api/rank-action", requireAuth, async (req, res) => {
  if (!BOT_ID) return res.status(503).json({ error: "Bot henüz hazır değil." });
  const { action, targetUsername, groupId, rankId } = req.body;
  if (!action || !targetUsername || !groupId) return res.status(400).json({ error: "Eksik parametre." });


  const rankUid = req.session.user.id;
  const lastRankAction = rankCooldowns.get(rankUid) || 0;
  const rankRemaining = RANK_COOLDOWN_MS - (Date.now() - lastRankAction);
  if (rankRemaining > 0) return res.status(429).json({ error: `Lütfen ${Math.ceil(rankRemaining / 1000)} saniye bekleyin.`, retryAfter: Math.ceil(rankRemaining / 1000) });

  const GROUP_ID = parseInt(groupId, 10);
  const groupCfg = cfg.GROUPS.find(g => g.groupId === GROUP_ID);
  if (!groupCfg) return res.status(400).json({ error: "Geçersiz grup." });

  const sessionRobloxId = req.session.user.roblox_id;
  if (!sessionRobloxId) return res.status(403).json({ error: "RoWifi verify yapılmamış." });

  try {
    const BOT_RANK = await noblox.getRankInGroup(GROUP_ID, BOT_ID);
    if (BOT_RANK === 0) return res.status(400).json({ error: "Bot bu grupta değil." });
    const groupRoles = await noblox.getRoles(GROUP_ID);
    const sortedRoles = groupRoles.filter(r => r.rank > 0 && r.rank < 255).sort((a, b) => a.rank - b.rank);
    const ISSUER_RANK = await noblox.getRankInGroup(GROUP_ID, sessionRobloxId);
    const teamMember = isTeamMember(req.session.user.id);
    const minAdmin = groupCfg.minAdminRank || 0;
    if (!teamMember && minAdmin > 0 && ISSUER_RANK < minAdmin) return res.status(403).json({ error: `Bu grupta işlem yapabilmek için en az ${minAdmin} rankına sahip olmanız gerekiyor.` });
    if (!teamMember && ISSUER_RANK === 0) return res.status(403).json({ error: "Siz bu grupta bulunmuyorsunuz." });
    const TARGET_ID = await noblox.getIdFromUsername(targetUsername);
    if (!TARGET_ID) return res.status(404).json({ error: "Hedef kullanıcı bulunamadı." });
    const TARGET_RANK = await noblox.getRankInGroup(GROUP_ID, TARGET_ID);
    if (TARGET_RANK === 0) return res.status(404).json({ error: "Hedef kullanıcı bu grupta değil." });
    if (TARGET_RANK === 255) return res.status(403).json({ error: "Grup sahibinin rütbesi değiştirilemez." });
    if (!teamMember && ISSUER_RANK <= TARGET_RANK) return res.status(403).json({ error: "Kendi rütbenizden yüksek veya eşit birinin rütbesini değiştiremezsiniz." });
    if (TARGET_RANK >= BOT_RANK) return res.status(403).json({ error: "Bot bu kullanıcının rütbesini değiştiremez." });
    const OLD_ROLE = groupRoles.find(r => r.rank === TARGET_RANK);
    let newRank;
    if (action === "promote") {
      const higherRoles = sortedRoles.filter(r => r.rank > TARGET_RANK && r.rank < BOT_RANK);
      if (!higherRoles.length) return res.status(403).json({ error: "Daha yüksek bir rütbe yok veya bot bu rütbeyi veremez." });
      newRank = higherRoles[0].rank;
    } else if (action === "demote") {
      const lowerRoles = sortedRoles.filter(r => r.rank < TARGET_RANK);
      if (!lowerRoles.length) return res.status(400).json({ error: "Bu kullanıcı zaten en düşük rütbede." });
      newRank = lowerRoles[lowerRoles.length - 1].rank;
    } else if (action === "setrank") {
      if (!rankId) return res.status(400).json({ error: "Rütbe seçilmedi." });
      newRank = parseInt(rankId, 10);
      if (newRank === TARGET_RANK) return res.status(400).json({ error: "Kullanıcı zaten bu rütbede." });
      if (newRank >= BOT_RANK) return res.status(403).json({ error: "Bot bu rütbeyi veremez." });
    } else return res.status(400).json({ error: "Geçersiz işlem." });

    await noblox.setRank(GROUP_ID, TARGET_ID, newRank);
    const NEW_ROLE = groupRoles.find(r => r.rank === newRank);
    rankCooldowns.set(rankUid, Date.now());
    let groupName = `Grup ${GROUP_ID}`;
    try { const gi = await noblox.getGroup(GROUP_ID); groupName = gi.name; } catch(e) {}
    if (groupCfg?.webhook) sendWebhookLog(groupCfg.webhook, { issuerDiscord: req.session.user.username, issuerRoblox: req.session.user.roblox_username, issuerRobloxId: sessionRobloxId, targetRoblox: targetUsername, targetRobloxId: TARGET_ID, action, oldRole: OLD_ROLE?.name || "?", newRole: NEW_ROLE?.name || "?", groupName });
    res.json({ userName: targetUsername, userId: TARGET_ID, oldRankId: TARGET_RANK, oldRole: OLD_ROLE?.name || "?", newRankId: newRank, newRole: NEW_ROLE?.name || "?", groupName });
  } catch (e) {
    console.error("[HATA] rank-action:", e.message);
    if (e.message?.includes("403")) return res.status(403).json({ error: "Botun bu işlem için yetkisi yok." });
    res.status(500).json({ error: "Bir hata oluştu: " + e.message });
  }
});

/* ── KULLANICI MEVCUT RÜTBE ── */
app.get("/api/user-rank", requireAuth, async (req, res) => {
  const { username, groupId } = req.query;
  if (!username || !groupId) return res.status(400).json({ error: "Eksik." });
  try {
    const uid = await noblox.getIdFromUsername(username);
    if (!uid) return res.status(404).json({ error: "Kullanıcı bulunamadı." });
    const gid = parseInt(groupId, 10);
    const groupRoles = await noblox.getRoles(gid);
    const rank = await noblox.getRankInGroup(gid, uid);
    const role = groupRoles.find(r => r.rank === rank);
    const sortedRoles = groupRoles.filter(r => r.rank > 0 && r.rank < 255).sort((a, b) => a.rank - b.rank);
    const higherRole = sortedRoles.find(r => r.rank > rank);
    const lowerRoles = sortedRoles.filter(r => r.rank < rank);
    const lowerRole = lowerRoles.length ? lowerRoles[lowerRoles.length - 1] : null;
    res.json({ rank, roleName: role?.name || "Bilinmiyor", nextRole: higherRole?.name || null, prevRole: lowerRole?.name || null });
  } catch(e) { res.status(500).json({ error: "Rütbe alınamadı." }); }
});

/* ════════════════════════════════════════
   OYUNLAR — Roblox Open Cloud API
════════════════════════════════════════ */
app.get("/api/games", requireAuth, async (req, res) => {
  const games = cfg.GAMES || [];
  if (!games.length) return res.json({ games: [] });
  const result = await Promise.all(games.map(async (g) => {
    // Aktiflik: kendi /api/game-servers mantığıyla kontrol et
    let active = false;
    try {
      const srvRes = await axios.get(`https://games.roblox.com/v1/games/${g.placeId}/servers/Public?sortOrder=Desc&limit=1`);
      active = (srvRes.data?.data?.length || 0) > 0;
    } catch(e) {}

    // Oyun ikonu — universeId gerekiyor, önce placeId'den universeId al
    let icon = "";
    try {
      const uRes = await axios.get(`https://apis.roblox.com/universes/v1/places/${g.placeId}/universe`);
      const universeId = uRes.data?.universeId;
      if (universeId) {
        const iconRes = await axios.get(`https://thumbnails.roblox.com/v1/games/icons?universeIds=${universeId}&returnPolicy=PlaceHolder&size=256x256&format=Png&isCircular=false`);
        icon = iconRes.data?.data?.[0]?.imageUrl || "";
      }
    } catch(e) {}

    return { placeId: g.placeId, name: g.name, icon, active };
  }));
  res.json({ games: result });
});

/* ── OYUN SERVER LİSTESİ ── */
// playerCache: { serverId: { userIds: [], cachedAt: 0 } }
const playerCache = {};

app.get("/api/game-servers", requireAuth, async (req, res) => {
  const placeId = parseInt(req.query.placeId, 10);
  if (!placeId) return res.status(400).json({ error: "placeId gerekli." });
  try {
    const srvRes = await axios.get(`https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Desc&limit=100`, {
      headers: { Cookie: `.ROBLOSECURITY=${cfg.ROBLOX_COOKIE}` }
    });
    const rawList = srvRes.data?.data || [];
    const servers = rawList.map(s => ({
      id: s.id, playerCount: s.playing, maxPlayers: s.maxPlayers,
      fps: Math.round(s.fps || 0), ping: Math.round(s.ping || 0)
    }));
    res.json({ servers });
  } catch(e) {
    console.error("[game-servers] HATA:", e.response?.status, e.message);
    res.status(500).json({ error: "Sunucular alınamadı." });
  }
});

// Open Cloud MessagingService subscribe — oyundan gelen userId listesini cache'e yazar
// Topic: "PlayerList-{serverId}" → payload: { serverId, userIds: [userId, ...] }
app.post("/api/oc-playerlist", async (req, res) => {
  // Bu endpoint Open Cloud webhook'u değil, Roblox scriptinin doğrudan POST atacağı endpoint
  // Güvenlik: gizli bir token ile doğrulama
  const auth = req.headers["x-pixlands-secret"];
  if (!auth || auth !== cfg.OC_SECRET) return res.status(401).json({ error: "Unauthorized" });
  const { serverId, userIds } = req.body;
  if (!serverId || !Array.isArray(userIds)) return res.status(400).json({ error: "Eksik parametre." });
  console.log(`[oc-playerlist] serverId=${serverId} userIds=${userIds.join(",")}`);
  playerCache[serverId] = { userIds, cachedAt: Date.now() };
  res.json({ ok: true });
});

app.get("/api/game-players", requireAuth, async (req, res) => {
  const placeId = parseInt(req.query.placeId, 10);
  const serverId = req.query.serverId;
  if (!placeId || !serverId) return res.status(400).json({ error: "Eksik parametre." });

  // Cache'den userId listesini al (oyundan MessagingService ile geldi)
  const cached = playerCache[serverId];
  const userIds = cached?.userIds || [];
  console.log(`[game-players] serverId=${serverId} cache userIds=${userIds.join(",") || "(yok)"}`);

  if (!userIds.length) {
    return res.json({ players: [] });
  }

  try {
    // 1. userId → username + displayName
    const nameRes = await axios.post(
      "https://users.roblox.com/v1/users",
      { userIds, excludeBannedUsers: false }
    );
    const nameMap = {};
    (nameRes.data?.data || []).forEach(u => { nameMap[u.id] = { name: u.name, displayName: u.displayName }; });

    // 2. userId → avatar (headshot thumbnail)
    const thumbRes = await axios.get(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${userIds.join(",")}&size=150x150&format=Png&isCircular=false`
    );
    const thumbMap = {};
    (thumbRes.data?.data || []).forEach(t => { thumbMap[t.targetId] = t.imageUrl || ""; });

    const players = userIds.map(uid => ({
      id:          uid,
      name:        nameMap[uid]?.name        || String(uid),
      displayName: nameMap[uid]?.displayName || String(uid),
      avatar:      thumbMap[uid]             || ""
    }));

    console.log(`[game-players] ${players.length} oyuncu döndürülüyor:`, players.map(p => p.name));
    res.json({ players });
  } catch(e) {
    console.error("[game-players] HATA:", e.response?.status, e.message);
    res.status(500).json({ players: [], error: "Oyuncular alınamadı." });
  }
});

/* ════════════════════════════════════════
   PROFİL endpoint — /api/profile/:discordId
════════════════════════════════════════ */
app.get("/api/profile/:discordId", async (req, res) => {
  const { discordId } = req.params;
  // CroxyDB'den profil çek
  let profileData = null;
  const raw = dbGet(`profiles.${discordId}.data`);
  if (raw) profileData = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!profileData) return res.status(404).json({ error: "Bu kullanıcı henüz giriş yapmadı." });
  const teamRole = cfg.TEAM.find(m => m.discordId === String(discordId));
  res.json({ ...profileData, teamRole: teamRole ? teamRole.tur : null });
});

/* ── EKIP ÜYESİ BAŞKASININ ROWİFİ'Sİ YENİLE ── */
app.post("/api/admin-refresh-profile/:discordId", async (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Giriş yapın." });
  if (!isTeamMember(req.session.user.id)) return res.status(403).json({ error: "Yetkisiz." });
  const { discordId } = req.params;
  
  try {
    const rw = await axios.get(`https://api.rowifi.xyz/v3/guilds/${cfg.DISCORD_GUILD_ID}/members/${discordId}`, { headers: { Authorization: `Bot ${cfg.ROWIFI_API_KEY}` } });
    const data = rw.data;
    const rawExisting = dbGet(`profiles.${discordId}.data`);
    let existing = rawExisting ? (typeof rawExisting === "string" ? JSON.parse(rawExisting) : rawExisting) : {};
    if (data?.roblox_id) {
      const name = await noblox.getUsernameFromId(data.roblox_id);
      existing.roblox_username = name; existing.roblox_id = data.roblox_id;
    }
    existing.updatedAt = Date.now();
    dbSet(`profiles.${discordId}.data`, existing);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: "Güncelleme başarısız." }); }
});

/* ════════════════════════════════════════
   İSTATİSTİKLER
════════════════════════════════════════ */
app.get("/api/stats", async (req, res) => {
  let memberCount = 0;
  if (true) {
    const raw = dbGet("stats.member_count");
    memberCount = parseInt(raw) || 0;
  }
  res.json({
    memberCount: formatCount(memberCount),
    groupCount: cfg.GROUPS.length,
    gameCount: (cfg.GAMES || []).length,
  });
});

/* ── STATIC ── */
app.use(express.static(path.join(__dirname, "public")));
app.get("/",          (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));
app.get("/dashboard", (_, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/manage",    (_, res) => res.sendFile(path.join(__dirname, "public", "dashboard.html")));
app.get("/profile",   (_, res) => res.sendFile(path.join(__dirname, "public", "profile.html")));
app.get("/terms",     (_, res) => res.sendFile(path.join(__dirname, "public", "terms.html")));
app.get("/privacy",   (_, res) => res.sendFile(path.join(__dirname, "public", "privacy.html")));

/* ── 404 ── */
app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, "public", "404.html"));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Sunucu aktif — Port: ${PORT}`));