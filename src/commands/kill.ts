import { type ChatInputCommandInteraction, ChannelType } from "discord.js";
import type { SessionManager } from "../session/session-manager.js";

export async function handleKillCommand(
  interaction: ChatInputCommandInteraction,
  sessions: SessionManager,
) {
  const channel = interaction.channel;

  if (
    !channel ||
    (channel.type !== ChannelType.PublicThread &&
      channel.type !== ChannelType.PrivateThread)
  ) {
    await interaction.reply({
      content: "Use this command inside an active Claude thread.",
      ephemeral: true,
    });
    return;
  }

  const killed = sessions.kill(channel.id);

  if (killed) {
    await interaction.reply("Session terminated.");
  } else {
    await interaction.reply({
      content: "No active session in this thread.",
      ephemeral: true,
    });
  }
}
