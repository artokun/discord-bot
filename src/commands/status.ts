import { type ChatInputCommandInteraction, EmbedBuilder } from "discord.js";
import type { SessionManager } from "../session/session-manager.js";

export async function handleStatusCommand(
  interaction: ChatInputCommandInteraction,
  sessions: SessionManager,
) {
  const status = sessions.getStatus();

  if (status.length === 0) {
    await interaction.reply({ content: "No active sessions.", ephemeral: true });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("Active Claude Sessions")
    .setColor(0x5865f2)
    .setDescription(
      status
        .map((s) => {
          const age = Math.round((Date.now() - s.startedAt.getTime()) / 60_000);
          const idle = Math.round((Date.now() - s.lastActivity.getTime()) / 60_000);
          return `**<#${s.threadId}>**\nStarted by: ${s.createdByName} | Age: ${age}m | Idle: ${idle}m | ${s.busy ? "⏳ Busy" : "💤 Idle"}`;
        })
        .join("\n\n"),
    )
    .setFooter({ text: `${status.length} active session(s)` })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}
