import { type ChatInputCommandInteraction, ChannelType } from "discord.js";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { SessionManager } from "../session/session-manager.js";
import type { Config } from "../config.js";

export async function handleDeployCommand(
  interaction: ChatInputCommandInteraction,
  sessions: SessionManager,
  config: Config,
) {
  const channel = interaction.channel;

  if (
    !channel ||
    (channel.type !== ChannelType.PublicThread &&
      channel.type !== ChannelType.PrivateThread)
  ) {
    await interaction.reply({
      content: "Use this command inside a Claude thread.",
      ephemeral: true,
    });
    return;
  }

  const projectDir = join(config.PROJECT_DIR, channel.id);

  if (!existsSync(projectDir)) {
    await interaction.reply({
      content: "No project directory found for this thread.",
      ephemeral: true,
    });
    return;
  }

  const files = readdirSync(projectDir);
  if (files.length === 0) {
    await interaction.reply({
      content: "Project directory is empty. Have Claude create some files first.",
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply();

  // TODO: Phase 3 — implement deployer service (GitHub + Render)
  await interaction.editReply(
    `📁 Project directory has ${files.length} file(s): \`${files.slice(0, 10).join("`, `")}\`\n\n_Deployment service coming in Phase 3._`,
  );
}
