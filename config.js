require("dotenv").config();

module.exports = {
  SITE_NAME: process.env.SITE_NAME,

  ROBLOX_COOKIE: process.env.ROBLOX_COOKIE,

  DISCORD_CLIENT_ID:     process.env.DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET,
  DISCORD_REDIRECT_URI:  process.env.DISCORD_REDIRECT_URI,
  DISCORD_BOT_TOKEN:     process.env.DISCORD_BOT_TOKEN,
  DISCORD_GUILD_ID:      process.env.DISCORD_GUILD_ID,
  DISCORD_GUILD_INVITE:  process.env.DISCORD_GUILD_INVITE,

  ROWIFI_API_KEY: process.env.ROWIFI_API_KEY,

  TEAM: [
    { sira: 1, tur: "Kurucu & Geliştirici", discordId: "1048511624606130287", description: "Pixlands sahibidir. Pixlands'a bağlı oyunları geliştirir." },
    { sira: 2, tur: "Geliştirici",          discordId: "1454747716088234024", description: "Pixlands site geliştiricisidir." },
    { sira: 3, tur: "Baş Moderatör",        discordId: "1124748161882279976", description: "Pixlands baş moderatörüdür." },
  ],

  GROUPS: [
    { groupId: 35205695, webhook: process.env.GROUP1_WEBHOOK, minAdminRank: 50 },
  ],

  GAMES: [
    { placeId: 117655204202868, name: "OpenCloud Test", openCloudApiKey: process.env.GAME1_API_KEY, minAdminRank: 50 },
  ],

  SESSION_SECRET: process.env.SESSION_SECRET || "fallback-secret",
  OC_SECRET:      process.env.OC_SECRET,

};
