import type { TextChannel, ThreadChannel } from "discord.js";

/**
 * Keeps Discord's "Bot is typing..." indicator alive.
 * Discord's typing indicator lasts ~10 seconds, so we re-trigger every 8s.
 */
export class TypingIndicator {
  private interval: ReturnType<typeof setInterval> | null = null;

  start(channel: TextChannel | ThreadChannel) {
    this.stop(); // Clear any existing
    try { channel.sendTyping(); } catch {}
    this.interval = setInterval(() => {
      try { channel.sendTyping(); } catch {}
    }, 8_000);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}
