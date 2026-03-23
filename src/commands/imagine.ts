import { type ChatInputCommandInteraction, AttachmentBuilder } from "discord.js";
import { ComfyUIClient } from "../services/comfyui.js";
import type { Config } from "../config.js";
import type { ImageModel } from "../services/comfyui.js";

export async function handleImagineCommand(
  interaction: ChatInputCommandInteraction,
  config: Config,
) {
  const prompt = interaction.options.getString("prompt", true);
  const model = (interaction.options.getString("model") ?? "flux-klein") as ImageModel;
  const size = interaction.options.getString("size") ?? "1024x1024";
  const loraStr = interaction.options.getString("lora");

  const [widthStr, heightStr] = size.split("x");
  const width = parseInt(widthStr, 10) || 1024;
  const height = parseInt(heightStr, 10) || 1024;

  // Parse LoRA string: "lora_name:0.8, other_lora:1.0"
  const loras = loraStr
    ? loraStr.split(",").map((l) => {
        const [name, str] = l.trim().split(":");
        return { name: name.trim(), strength: str ? parseFloat(str) : 1.0 };
      })
    : undefined;

  await interaction.deferReply();

  const client = new ComfyUIClient(config.COMFY_URL);

  try {
    await interaction.editReply(
      `Generating with **${model}** (${width}x${height})${loras ? ` + ${loras.length} LoRA(s)` : ""}... ⏳`,
    );

    const imageBuffer = await client.generateImage({
      prompt,
      model,
      width,
      height,
      loras,
    });

    const attachment = new AttachmentBuilder(imageBuffer, {
      name: "generated.png",
    });

    await interaction.editReply({
      content: `**${prompt}**\n_Model: ${model} | ${width}x${height}${loras ? ` | LoRAs: ${loras.map((l) => l.name.split("\\").pop()?.split(".")[0]).join(", ")}` : ""}_`,
      files: [attachment],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await interaction.editReply(`Image generation failed: ${msg}`);
  }
}
