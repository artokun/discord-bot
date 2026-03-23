import {
  type ChatInputCommandInteraction,
  ChannelType,
  type ThreadChannel,
} from "discord.js";
import type { SessionManager } from "../session/session-manager.js";
import { TypingIndicator } from "../discord/typing-indicator.js";
import type { Config } from "../config.js";

export type WireSessionFn = (threadId: string, thread: ThreadChannel) => void;

export async function handleAskCommand(
  interaction: ChatInputCommandInteraction,
  sessions: SessionManager,
  config: Config,
  typingIndicators: Map<string, TypingIndicator>,
  wireSession: WireSessionFn,
) {
  const prompt = interaction.options.getString("prompt", true);
  const username = interaction.user.displayName || interaction.user.username;

  // Must be in a text channel (not DM)
  if (!interaction.channel || interaction.channel.type === ChannelType.DM) {
    await interaction.reply({ content: "Use this command in a server channel.", ephemeral: true });
    return;
  }

  await interaction.deferReply();

  // Create a thread for this conversation
  const threadName = prompt.slice(0, 95) || "Claude conversation";
  let thread: ThreadChannel;

  try {
    if ("threads" in interaction.channel) {
      thread = await interaction.channel.threads.create({
        name: threadName,
        autoArchiveDuration: 60,
        reason: `Claude session started by ${username}`,
      });
    } else {
      await interaction.editReply("Can't create threads in this channel type.");
      return;
    }
  } catch (err) {
    await interaction.editReply(`Failed to create thread: ${err}`);
    return;
  }

  // Spawn Claude session
  const attributed = `[${username}]: ${prompt}`;
  const result = sessions.spawn(
    thread.id,
    interaction.channelId,
    interaction.user.id,
    username,
    attributed,
  );

  if (result === "max_sessions") {
    await thread.send(
      `Too many active sessions (${config.MAX_CONCURRENT_SESSIONS}). Use \`/kill\` on an idle session first.`,
    );
    await interaction.editReply("Session limit reached. Thread created but Claude not started.");
    return;
  }

  // Wire up Discord event listeners for this session
  wireSession(thread.id, thread);

  // Start typing indicator
  const typing = new TypingIndicator();
  typingIndicators.set(thread.id, typing);
  typing.start(thread);

  await interaction.editReply(`Thread created: ${thread.toString()} — Claude is thinking...`);
}
