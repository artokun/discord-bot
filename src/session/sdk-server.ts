import type { ServerWebSocket } from "bun";
import type { ClaudeProcess } from "./claude-process.js";

interface WsData {
  sessionId: string;
}

/**
 * Local WebSocket server that Claude CLI connects to via --sdk-url.
 * One server shared across all sessions — routes by URL path.
 *
 * Claude connects to: ws://127.0.0.1:{port}/session/{threadId}
 */
export class SdkServer {
  private server: ReturnType<typeof Bun.serve<WsData>>;
  private sessions = new Map<string, ClaudeProcess>();

  constructor(port: number) {
    const self = this;

    this.server = Bun.serve<WsData>({
      port,
      fetch(req, server) {
        const url = new URL(req.url);
        const match = url.pathname.match(/^\/session\/(.+)$/);
        if (!match) {
          return new Response("Not found", { status: 404 });
        }

        const sessionId = match[1];
        const upgraded = server.upgrade(req, { data: { sessionId } });
        if (!upgraded) {
          return new Response("WebSocket upgrade failed", { status: 500 });
        }
      },
      websocket: {
        open(ws: ServerWebSocket<WsData>) {
          const sessionId = ws.data.sessionId;
          console.log(`[sdk-server] WebSocket opened for session ${sessionId}`);
          const proc = self.sessions.get(sessionId);
          if (proc) {
            proc.onWebSocketOpen(ws);
          } else {
            console.warn(`[sdk-server] No session registered for ${sessionId}`);
          }
        },
        message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
          const sessionId = ws.data.sessionId;
          const data = typeof message === "string" ? message : new TextDecoder().decode(message);
          const proc = self.sessions.get(sessionId);
          if (proc) {
            proc.onWebSocketMessage(data);
          }
        },
        close(ws: ServerWebSocket<WsData>) {
          const sessionId = ws.data.sessionId;
          console.log(`[sdk-server] WebSocket closed for session ${sessionId}`);
          const proc = self.sessions.get(sessionId);
          if (proc) {
            proc.onWebSocketClose();
          }
        },
      },
    });

    console.log(`[sdk-server] listening on ws://127.0.0.1:${port}`);
  }

  registerSession(sessionId: string, proc: ClaudeProcess) {
    this.sessions.set(sessionId, proc);
  }

  unregisterSession(sessionId: string) {
    this.sessions.delete(sessionId);
  }

  get port(): number {
    return this.server.port ?? 7888;
  }

  stop() {
    this.server.stop();
  }
}
