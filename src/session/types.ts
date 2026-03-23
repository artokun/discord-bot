/** Session state for a Discord thread ↔ Claude process */
export interface Session {
  threadId: string;
  channelId: string;
  createdBy: string; // Discord user ID
  createdByName: string; // Discord username
  startedAt: Date;
  lastActivity: Date;
  agentBusy: boolean;
  messageQueue: Array<{ username: string; text: string }>;
  turnTextBuffer: string[];
  /** The Claude CLI process wrapper (manages WebSocket + NDJSON) */
  process: import("./claude-process.js").ClaudeProcess;
}
