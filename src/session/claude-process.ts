import { mkdirSync } from "node:fs";
import { EventEmitter } from "node:events";
import type { ServerWebSocket } from "bun";

export interface ClaudeProcessEvents {
  text: [text: string];
  tool_use: [toolName: string, params: string];
  tool_progress: [toolName: string, elapsed: number];
  result: [subtype: string, text: string];
  error: [error: string];
  exit: [code: number | null];
}

/**
 * Manages a Claude CLI process connected via --sdk-url WebSocket.
 *
 * Flow:
 * 1. We start a WebSocket server (shared across sessions via SdkServer)
 * 2. We spawn `claude --sdk-url ws://localhost:PORT/session/{id} -p ""`
 * 3. Claude connects to our WebSocket
 * 4. We send the initial prompt as a user message
 * 5. Claude sends NDJSON: control_request, assistant, tool_progress, result
 * 6. We auto-approve control_requests, collect text, emit events
 * 7. For follow-up messages, we send more user messages over the WebSocket
 */
export class ClaudeProcess extends EventEmitter<ClaudeProcessEvents> {
  private proc: ReturnType<typeof Bun.spawn> | null = null;
  private _exited = false;
  private _ws: ServerWebSocket<{ sessionId: string }> | null = null;
  private _pendingPrompt: string | null = null;
  private _messageQueue: string[] = [];
  private _agentBusy = false;
  turnTextBlocks: string[] = [];

  constructor(
    private threadId: string,
    private cwd: string,
    private roleFile: string,
    private maxTurns: number,
    private sdkPort: number,
    private mcpConfigPath?: string,
  ) {
    super();
  }

  get exited() { return this._exited; }
  get agentBusy() { return this._agentBusy; }

  spawn(initialPrompt: string): void {
    mkdirSync(this.cwd, { recursive: true });

    this._pendingPrompt = initialPrompt;

    const sdkUrl = `ws://127.0.0.1:${this.sdkPort}/session/${this.threadId}`;

    const args = [
      "--sdk-url", sdkUrl,
      "--print",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--verbose",
      "--permission-mode", "bypassPermissions",
      "--max-turns", String(this.maxTurns),
      "--append-system-prompt-file", this.roleFile,
    ];

    if (this.mcpConfigPath) {
      args.push("--mcp-config", this.mcpConfigPath);
    }

    args.push("-p", "");

    console.log(`[${this.threadId}] spawning claude with --sdk-url=${sdkUrl}`);

    const proc = Bun.spawn(["claude", ...args], {
      cwd: this.cwd,
      stdout: "pipe",
      stderr: "pipe",
      onExit: (_proc, exitCode, signalCode, _error) => {
        console.log(`[${this.threadId}] claude exited (code=${exitCode}, signal=${signalCode})`);
        this._exited = true;
        this._ws = null;
        this.emit("exit", exitCode);
      },
    });

    this.proc = proc;

    // Log stdout (mostly for debugging — real data comes via WebSocket)
    this.pipeStream(proc.stdout as unknown as ReadableStream<Uint8Array>, "stdout");
    this.pipeStream(proc.stderr as unknown as ReadableStream<Uint8Array>, "stderr");
  }

  /** Called by SdkServer when Claude connects to our WebSocket */
  onWebSocketOpen(ws: ServerWebSocket<{ sessionId: string }>) {
    console.log(`[${this.threadId}] Claude connected via WebSocket`);
    this._ws = ws;

    // Send pending prompt if we have one
    if (this._pendingPrompt) {
      const prompt = this._pendingPrompt;
      this._pendingPrompt = null;
      this._agentBusy = true;
      this.sendUserMessageNow(prompt);
    }
  }

  /** Called by SdkServer when Claude sends a message over WebSocket */
  onWebSocketMessage(data: string) {
    for (const line of data.split("\n").filter(l => l.trim())) {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(line); } catch { continue; }
      const type = msg.type as string;

      switch (type) {
        case "control_request":
          this.handleControlRequest(msg);
          break;
        case "assistant":
          this.handleAssistantMessage(msg);
          break;
        case "tool_progress": {
          const toolName = msg.tool_name as string ?? "Working";
          const elapsed = msg.elapsed_time_seconds as number ?? 0;
          this.emit("tool_progress", toolName, elapsed);
          break;
        }
        case "result":
          this.handleResultMessage(msg);
          break;
        case "system":
          if ((msg.subtype as string) === "init") {
            console.log(`[${this.threadId}] Claude session initialized (model=${msg.model})`);
          }
          break;
      }
    }
  }

  onWebSocketClose() {
    console.log(`[${this.threadId}] Claude WebSocket disconnected`);
    this._ws = null;
  }

  /** Send a follow-up user message. Queues if agent is busy. */
  pushUserMessage(text: string): "sent" | "queued" | "no_connection" {
    if (this._agentBusy) {
      this._messageQueue.push(text);
      console.log(`[${this.threadId}] queued message (agent busy, queue=${this._messageQueue.length})`);
      return "queued";
    }
    return this.sendUserMessageNow(text) ? "sent" : "no_connection";
  }

  kill(): void {
    if (!this.proc || this._exited) return;
    console.log(`[${this.threadId}] killing claude process`);
    this.proc.kill("SIGTERM");
    setTimeout(() => {
      if (!this._exited && this.proc) {
        this.proc.kill("SIGKILL");
      }
    }, 5000);
  }

  // ── Private ──────────────────────────────────────────────────

  private sendUserMessageNow(text: string): boolean {
    if (!this._ws) {
      console.warn(`[${this.threadId}] no WebSocket connection`);
      return false;
    }

    const payload = JSON.stringify({
      type: "user",
      session_id: "",
      message: { role: "user", content: [{ type: "text", text }] },
      parent_tool_use_id: null,
    }) + "\n";

    this._agentBusy = true;
    this.turnTextBlocks = [];
    this._ws.send(payload);
    console.log(`[${this.threadId}] sent user message (${text.length} chars)`);
    return true;
  }

  /** Drain queued messages after a result arrives */
  drainMessageQueue() {
    this._agentBusy = false;
    if (this._messageQueue.length > 0) {
      const combined = this._messageQueue.join("\n\n---\n\n");
      this._messageQueue = [];
      this.sendUserMessageNow(combined);
    }
  }

  private handleControlRequest(msg: Record<string, unknown>) {
    if (!this._ws) return;

    const requestId = msg.request_id as string;
    const request = msg.request as Record<string, unknown>;
    const subtype = request?.subtype as string;

    if (subtype === "can_use_tool") {
      const toolUseId = request.tool_use_id as string;
      const toolInput = request.input as Record<string, unknown> ?? {};
      console.log(`[${this.threadId}] auto-approving tool: ${request.tool_name}`);
      this._ws.send(JSON.stringify({
        type: "control_response",
        response: {
          subtype: "success",
          request_id: requestId,
          response: { behavior: "allow", updatedInput: toolInput, toolUseID: toolUseId },
        },
      }) + "\n");
    } else {
      this._ws.send(JSON.stringify({
        type: "control_response",
        response: { subtype: "success", request_id: requestId, response: {} },
      }) + "\n");
      if (subtype === "initialize") {
        console.log(`[${this.threadId}] responded to initialize`);
      }
    }
  }

  private handleAssistantMessage(msg: Record<string, unknown>) {
    const message = msg.message as Record<string, unknown> | undefined;
    if (!message) return;
    const content = message.content as Array<Record<string, unknown>> | undefined;
    if (!content) return;

    for (const block of content) {
      const blockType = block.type as string;
      if (blockType === "text" && typeof block.text === "string") {
        const text = (block.text as string).trim();
        if (text && !text.startsWith("<thinking>")) {
          this.turnTextBlocks.push(text);
          this.emit("text", text);
        }
      } else if (blockType === "tool_use") {
        const toolName = block.name as string ?? "Unknown";
        const input = block.input as Record<string, unknown> ?? {};
        let param = "";
        if (input.command) param = String(input.command);
        else if (input.pattern) param = String(input.pattern);
        else if (input.file_path) param = String(input.file_path);
        else if (input.query) param = String(input.query);
        else param = JSON.stringify(input).slice(0, 200);
        this.emit("tool_use", toolName, param);
      }
    }
  }

  private handleResultMessage(msg: Record<string, unknown>) {
    const subtype = msg.subtype as string;
    const resultText = (msg.result as string ?? "").trim();
    const accumulatedText = this.turnTextBlocks.join("\n\n");
    this.turnTextBlocks = [];

    console.log(`[${this.threadId}] result: ${subtype}`);

    if (subtype === "success") {
      this.emit("result", subtype, resultText || accumulatedText);
    } else {
      const errors = msg.errors as string[] | undefined;
      this.emit("result", subtype, errors?.join(", ") ?? subtype);
    }

    // Drain queued messages
    this.drainMessageQueue();
  }

  private async pipeStream(stream: ReadableStream<Uint8Array>, label: string) {
    if (!stream) return;
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value).trim();
        if (text) {
          if (label === "stderr") {
            console.error(`[${this.threadId}] ${label}: ${text.slice(0, 300)}`);
          }
          // stdout in --sdk-url mode is mostly empty; real data goes through WebSocket
        }
      }
    } catch {}
  }
}
