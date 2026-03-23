import { type ChatInputCommandInteraction, AttachmentBuilder } from "discord.js";
import { ComfyUIClient } from "../services/comfyui.js";
import type { Config } from "../config.js";
import type { VideoModel } from "../services/comfyui.js";

export async function handleVideoCommand(
  interaction: ChatInputCommandInteraction,
  config: Config,
) {
  const prompt = interaction.options.getString("prompt", true);
  const model = (interaction.options.getString("model") ?? "wan-t2v") as VideoModel;
  const size = interaction.options.getString("size") ?? "832x480";
  const lengthOpt = interaction.options.getInteger("length") ?? 81;
  const loraStr = interaction.options.getString("lora");
  const imageAttachment = interaction.options.getAttachment("image");

  const [widthStr, heightStr] = size.split("x");
  const width = parseInt(widthStr, 10) || 832;
  const height = parseInt(heightStr, 10) || 480;

  const loras = loraStr
    ? loraStr.split(",").map((l) => {
        const [name, str] = l.trim().split(":");
        return { name: name.trim(), strength: str ? parseFloat(str) : 1.0 };
      })
    : undefined;

  await interaction.deferReply();

  const client = new ComfyUIClient(config.COMFY_URL);

  try {
    const frames = Math.max(5, lengthOpt);
    const estSeconds = Math.round(frames / 16);

    await interaction.editReply(
      `Generating **${model}** video (${width}x${height}, ${frames} frames ≈ ${estSeconds}s)... ⏳\nThis may take several minutes.`,
    );

    // If user attached an image for I2V, download it to temp
    let inputImagePath: string | undefined;
    if (imageAttachment?.url) {
      const resp = await fetch(imageAttachment.url);
      const buf = Buffer.from(await resp.arrayBuffer());
      inputImagePath = `/tmp/discord-video-input-${Date.now()}.png`;
      await Bun.write(inputImagePath, buf);
    }

    const videoBuffer = await client.generateVideo({
      prompt,
      model,
      width,
      height,
      length: frames,
      loras,
      inputImagePath,
    });

    const attachment = new AttachmentBuilder(videoBuffer, {
      name: "generated.mp4",
    });

    await interaction.editReply({
      content: `**${prompt}**\n_Model: ${model} | ${width}x${height} | ${frames} frames_`,
      files: [attachment],
    });

    // Cleanup temp file
    if (inputImagePath) {
      try { await Bun.write(inputImagePath, ""); } catch {}
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await interaction.editReply(`Video generation failed: ${msg}`);
  }
}
