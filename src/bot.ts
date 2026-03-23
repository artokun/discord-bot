import {
  Client,
  GatewayIntentBits,
  ChannelType,
  type Message,
  type Interaction,
  type ThreadChannel,
} from "discord.js";
import { SessionManager } from "./session/session-manager.js";
import { TypingIndicator } from "./discord/typing-indicator.js";
import {
  sendAssistantResponse,
  toolUseEmbed,
  errorEmbed,
} from "./discord/renderer.js";
import { handleAskCommand } from "./commands/ask.js";
import { handleImagineCommand } from "./commands/imagine.js";
import { handleKillCommand } from "./commands/kill.js";
import { handleStatusCommand } from "./commands/status.js";
import { handleDeployCommand } from "./commands/deploy.js";
import { handleVideoCommand } from "./commands/video.js";
import type { Config } from "./config.js";

export function createBot(config: Config) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  const sessions = new SessionManager(config);

  // Map threadId -> TypingIndicator for cleanup
  const typingIndicators = new Map<string, TypingIndicator>();

  /** Wire up session events for a newly spawned session */
  function wireSessionEvents(threadId: string, thread: ThreadChannel) {
    const session = sessions.getSession(threadId);
    if (!session) return;

    const proc = session.process;
    let toolMsgCount = 0;

    proc.on("tool_use", async (toolName, param) => {
      toolMsgCount++;
      // Only show every 3rd tool use to avoid spam
      if (toolMsgCount % 3 === 1) {
        try {
          await thread.send({ embeds: [toolUseEmbed(toolName, param)] });
        } catch {}
      }
    });

    proc.on("result", async (subtype, resultText) => {
      // Stop typing
      const typing = typingIndicators.get(threadId);
      if (typing) {
        typing.stop();
        typingIndicators.delete(threadId);
      }

      toolMsgCount = 0;

      if (subtype === "success") {
        // resultText already contains the final text (ClaudeProcess combines accumulated + result)
        if (resultText) {
          await sendAssistantResponse(thread, resultText);
        }
      } else {
        await thread.send({
          embeds: [errorEmbed(`Session ended: ${resultText || subtype}`)],
        });
      }

      // Queue draining is handled internally by ClaudeProcess
      sessions.drainQueue(threadId);

      // If queue drained and started new turn, restart typing
      const updatedSession = sessions.getSession(threadId);
      if (updatedSession?.process.agentBusy) {
        const newTyping = new TypingIndicator();
        typingIndicators.set(threadId, newTyping);
        newTyping.start(thread);
      }
    });

    proc.on("exit", async (code) => {
      const typing = typingIndicators.get(threadId);
      if (typing) {
        typing.stop();
        typingIndicators.delete(threadId);
      }

      if (code !== 0 && code !== null) {
        try {
          await thread.send({
            embeds: [errorEmbed(`Claude process exited with code ${code}`)],
          });
        } catch {}
      }
    });
  }

  client.once("ready", () => {
    console.log(`Bot logged in as ${client.user?.tag}`);
  });

  // Handle slash commands
  client.on("interactionCreate", async (interaction: Interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
      switch (interaction.commandName) {
        case "ask":
          await handleAskCommand(interaction, sessions, config, typingIndicators, wireSessionEvents);
          break;
        case "imagine":
          await handleImagineCommand(interaction, config);
          break;
        case "kill":
          await handleKillCommand(interaction, sessions);
          break;
        case "status":
          await handleStatusCommand(interaction, sessions);
          break;
        case "deploy":
          await handleDeployCommand(interaction, sessions, config);
          break;
        case "video":
          await handleVideoCommand(interaction, config);
          break;
      }
    } catch (err) {
      console.error(`[bot] command error:`, err);
    }
  });

  // Handle follow-up messages in active threads
  client.on("messageCreate", async (message: Message) => {
    if (message.author.bot) return;

    // Only process messages in threads
    if (
      message.channel.type !== ChannelType.PublicThread &&
      message.channel.type !== ChannelType.PrivateThread
    ) {
      return;
    }

    const thread = message.channel as ThreadChannel;
    const session = sessions.getSession(thread.id);
    if (!session) return; // Not a managed thread

    const username = message.author.displayName || message.author.username;
    let text = message.content;

    // Download attachments into session working directory
    const attachmentNotes: string[] = [];
    if (message.attachments.size > 0) {
      const { join } = await import("node:path");
      const { mkdirSync } = await import("node:fs");
      const projectDir = join(config.PROJECT_DIR, thread.id);
      mkdirSync(projectDir, { recursive: true });

      for (const [, attachment] of message.attachments) {
        try {
          const resp = await fetch(attachment.url);
          const buf = Buffer.from(await resp.arrayBuffer());
          const filePath = join(projectDir, attachment.name);
          await Bun.write(filePath, buf);
          attachmentNotes.push(`[Attachment saved: ${attachment.name} (${buf.length} bytes) → ${filePath}]`);
          console.log(`[${thread.id}] downloaded attachment: ${attachment.name} (${buf.length} bytes)`);
        } catch (err) {
          attachmentNotes.push(`[Failed to download attachment: ${attachment.name}]`);
          console.error(`[${thread.id}] attachment download failed:`, err);
        }
      }
    }

    // Build the full message with attachment info
    if (attachmentNotes.length > 0) {
      text = text + "\n\n" + attachmentNotes.join("\n");
    }

    if (!text.trim()) return;

    const result = sessions.sendMessage(thread.id, username, text);

    if (result === "queued") {
      await message.react("👀"); // Acknowledge queued
    } else if (result === "sent") {
      // Start typing indicator
      const typing = new TypingIndicator();
      typingIndicators.set(thread.id, typing);
      typing.start(thread);
    }
  });

  // Cleanup on shutdown
  function shutdown() {
    console.log("Shutting down...");
    for (const typing of typingIndicators.values()) {
      typing.stop();
    }
    sessions.destroy();
    client.destroy();
    process.exit(0);
  }

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return { client, sessions };
}
