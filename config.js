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

  SESSION_SECRET: process.env.SESSION_SECRET || "fallback-secret",
  OC_SECRET: process.env.OC_SECRET,
};
