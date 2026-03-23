/**
 * One-time script to register slash commands with Discord.
 * Run: bun run src/commands/register.ts
 */
import { REST, Routes, SlashCommandBuilder } from "discord.js";
import { loadConfig } from "../config.js";

const config = loadConfig();

const commands = [
  new SlashCommandBuilder()
    .setName("ask")
    .setDescription("Start a Claude Code session in a new thread")
    .addStringOption((opt) =>
      opt.setName("prompt").setDescription("Your prompt for Claude").setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName("imagine")
    .setDescription("Generate an image via ComfyUI")
    .addStringOption((opt) =>
      opt.setName("prompt").setDescription("Image description").setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("model")
        .setDescription("Model to use")
        .addChoices(
          { name: "Flux Klein (fast)", value: "flux-klein" },
          { name: "Flux 1 Dev (quality)", value: "flux-dev" },
          { name: "SDXL (photorealistic)", value: "sdxl" },
          { name: "Z-Image Turbo (fast, versatile)", value: "zimage" },
          { name: "Qwen Image (realistic)", value: "qwen-image" },
          { name: "Illustrious (anime)", value: "illustrious" },
        ),
    )
    .addStringOption((opt) =>
      opt
        .setName("size")
        .setDescription("Image size (WxH)")
        .addChoices(
          { name: "1024x1024 (square)", value: "1024x1024" },
          { name: "1280x768 (landscape)", value: "1280x768" },
          { name: "768x1280 (portrait)", value: "768x1280" },
          { name: "1536x1024 (wide)", value: "1536x1024" },
        ),
    )
    .addStringOption((opt) =>
      opt.setName("lora").setDescription("LoRA(s): name:strength, name:strength"),
    ),

  new SlashCommandBuilder()
    .setName("video")
    .setDescription("Generate a video via Wan 2.2")
    .addStringOption((opt) =>
      opt.setName("prompt").setDescription("Video description").setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName("model")
        .setDescription("Model to use")
        .addChoices(
          { name: "Wan 2.2 Text-to-Video", value: "wan-t2v" },
          { name: "Wan 2.2 Image-to-Video", value: "wan-i2v" },
        ),
    )
    .addStringOption((opt) =>
      opt
        .setName("size")
        .setDescription("Video size")
        .addChoices(
          { name: "832x480 (landscape)", value: "832x480" },
          { name: "480x832 (portrait)", value: "480x832" },
          { name: "624x624 (square)", value: "624x624" },
        ),
    )
    .addIntegerOption((opt) =>
      opt.setName("length").setDescription("Frame count (default 81 ≈ 5s)").setMinValue(5).setMaxValue(161),
    )
    .addStringOption((opt) =>
      opt.setName("lora").setDescription("LoRA(s): name:strength, name:strength"),
    )
    .addAttachmentOption((opt) =>
      opt.setName("image").setDescription("Start image for I2V"),
    ),

  new SlashCommandBuilder()
    .setName("kill")
    .setDescription("Terminate the Claude session in this thread"),

  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show active Claude sessions"),

  new SlashCommandBuilder()
    .setName("deploy")
    .setDescription("Deploy the project from this thread"),
];

const rest = new REST({ version: "10" }).setToken(config.DISCORD_BOT_TOKEN);

console.log("Registering slash commands...");

try {
  await rest.put(Routes.applicationCommands(config.DISCORD_CLIENT_ID), {
    body: commands.map((c) => c.toJSON()),
  });
  console.log(`Registered ${commands.length} commands.`);
} catch (err) {
  console.error("Failed to register commands:", err);
  process.exit(1);
}
