import { join } from "node:path";
import { ClaudeProcess } from "./claude-process.js";
import { SdkServer } from "./sdk-server.js";
import type { Session } from "./types.js";
import type { Config } from "../config.js";

const SDK_PORT = 7888;

export class SessionManager {
  private sessions = new Map<string, Session>();
  private sweepInterval: ReturnType<typeof setInterval>;
  private sdkServer: SdkServer;

  constructor(private config: Config) {
    this.sdkServer = new SdkServer(SDK_PORT);
    this.sweepInterval = setInterval(() => this.sweep(), 60_000);
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  getSession(threadId: string): Session | undefined {
    return this.sessions.get(threadId);
  }

  getStatus(): Array<{
    threadId: string;
    createdByName: string;
    startedAt: Date;
    lastActivity: Date;
    busy: boolean;
  }> {
    return Array.from(this.sessions.values()).map((s) => ({
      threadId: s.threadId,
      createdByName: s.createdByName,
      startedAt: s.startedAt,
      lastActivity: s.lastActivity,
      busy: s.process.agentBusy,
    }));
  }

  spawn(
    threadId: string,
    channelId: string,
    userId: string,
    username: string,
    initialPrompt: string,
  ): Session | "max_sessions" {
    if (this.sessions.has(threadId)) {
      this.kill(threadId);
    }

    if (this.sessions.size >= this.config.MAX_CONCURRENT_SESSIONS) {
      return "max_sessions";
    }

    // Use bot source directory as CWD so Claude can read/modify bot code
    // Project files go into PROJECT_DIR/{threadId} subfolder
    const cwd = join(import.meta.dirname ?? ".", "..", "..");
    const roleFile = join(import.meta.dirname ?? ".", "..", "..", "roles", "discord-assistant.md");
    const mcpConfigPath = join(import.meta.dirname ?? ".", "..", "..", "mcp-discord.json");

    const proc = new ClaudeProcess(
      threadId,
      cwd,
      roleFile,
      this.config.MAX_TURNS,
      this.sdkServer.port,
      mcpConfigPath,
    );

    // Register with SDK server so WebSocket connections route to this process
    this.sdkServer.registerSession(threadId, proc);

    const session: Session = {
      threadId,
      channelId,
      createdBy: userId,
      createdByName: username,
      startedAt: new Date(),
      lastActivity: new Date(),
      agentBusy: true,
      messageQueue: [],
      turnTextBuffer: [],
      process: proc,
    };

    this.sessions.set(threadId, session);

    proc.on("result", () => {
      session.agentBusy = false;
    });

    proc.on("exit", () => {
      this.sdkServer.unregisterSession(threadId);
      this.sessions.delete(threadId);
    });

    proc.spawn(initialPrompt);
    return session;
  }

  /**
   * Send a user message to an active session.
   * Uses the WebSocket-based pushUserMessage (queues if busy).
   */
  sendMessage(
    threadId: string,
    username: string,
    text: string,
  ): "sent" | "queued" | "no_session" {
    const session = this.sessions.get(threadId);
    if (!session) return "no_session";

    session.lastActivity = new Date();
    const attributed = `[${username}]: ${text}`;

    const result = session.process.pushUserMessage(attributed);
    return result === "no_connection" ? "no_session" : result;
  }

  /** Drain queued messages after a result comes back */
  drainQueue(threadId: string): void {
    // ClaudeProcess handles its own queue draining in handleResultMessage
    const session = this.sessions.get(threadId);
    if (session) {
      session.agentBusy = session.process.agentBusy;
    }
  }

  kill(threadId: string): boolean {
    const session = this.sessions.get(threadId);
    if (!session) return false;
    session.process.kill();
    this.sdkServer.unregisterSession(threadId);
    return true;
  }

  killAll(): void {
    for (const [threadId] of this.sessions) {
      this.kill(threadId);
    }
  }

  private sweep() {
    if (this.sessions.size > 0) {
      console.log(`[heartbeat] ${this.sessions.size} active session(s)`);
    }
  }

  destroy() {
    clearInterval(this.sweepInterval);
    this.killAll();
    this.sdkServer.stop();
  }
}
