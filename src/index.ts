import { loadConfig } from "./config.js";
import { createBot } from "./bot.js";

const config = loadConfig();
const { client, sessions } = createBot(config);

console.log("Starting Discord bot...");
await client.login(config.DISCORD_BOT_TOKEN);
