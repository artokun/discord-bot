# Discord Bot + Claude Code

## Overview

Discord bot that spawns Claude Code CLI processes per thread, enabling collaborative AI-assisted coding directly in Discord. Supports image generation via ComfyUI.

## Architecture

```
Discord (discord.js) → Bot Process (Bun)
   ↕ messages              ↕ spawns per thread
Discord Channels/Threads   Claude CLI (stdin/stdout NDJSON)
```

- **No PartyKit** — Discord.js IS the persistent connection
- **Thread-per-session** — each `/ask` creates a thread with its own Claude process
- **Multi-user** — messages prefixed with `[username]:` for attribution
- **NDJSON streaming** — bidirectional stdin/stdout with Claude CLI

## Repo Layout

```
├── src/
│   ├── index.ts              # Entry point
│   ├── bot.ts                # Discord client, event handlers
│   ├── config.ts             # Env validation (Zod)
│   ├── commands/
│   │   ├── register.ts       # One-time slash command registration
│   │   ├── ask.ts            # /ask — start thread + Claude session
│   │   ├── imagine.ts        # /imagine — ComfyUI image generation
│   │   ├── kill.ts           # /kill — terminate session
│   │   ├── status.ts         # /status — list active sessions
│   │   └── deploy.ts         # /deploy — deploy thread's project
│   ├── session/
│   │   ├── claude-process.ts # Spawn Claude CLI, NDJSON piping
│   │   ├── session-manager.ts# Session lifecycle, timeouts
│   │   └── types.ts          # NDJSON + session types
│   ├── discord/
│   │   ├── renderer.ts       # Chunk responses for 2000-char limit
│   │   └── typing-indicator.ts
│   ├── services/
│   │   └── comfyui.ts        # ComfyUI REST client
│   └── utils/
│       └── ndjson.ts         # NDJSON line parser
├── roles/
│   └── discord-assistant.md  # System prompt for Claude sessions
├── mcp-discord.json          # MCP config for Claude agents
└── _reference/               # Patterns from the original orchestrator (gitignored)
```

## Running

```bash
bun install

# Register slash commands (one-time)
bun run register

# Start the bot
bun run dev
```

## Environment Variables

See `.env.example`. Required:
- `DISCORD_BOT_TOKEN` — Discord bot token
- `DISCORD_CLIENT_ID` — Discord app client ID
- `COMFY_URL` — ComfyUI server URL (default: https://unc-cozy.artokun.io)

## Slash Commands

| Command | Description |
|---------|-------------|
| `/ask <prompt>` | Start a Claude conversation in a new thread |
| `/imagine <prompt> [model] [size]` | Generate an image via ComfyUI |
| `/kill` | Terminate the Claude session in this thread |
| `/status` | Show all active Claude sessions |
| `/deploy` | Deploy the project from this thread |

## Key Patterns

### NDJSON Streaming
Claude CLI runs with `--output-format stream-json --input-format stream-json`. The bot reads stdout line by line, parses JSON, and handles message types: `control_request` (auto-approve), `assistant` (text/tool_use), `tool_progress`, `result`, `system`.

### Message Queuing
When Claude is busy, incoming messages queue. On `result`, the queue drains by combining messages with `---` separators.

### Session Lifecycle
- Idle timeout: 30 min
- Max duration: 2 hours
- Max concurrent: 5 (configurable)
- Each session gets `/tmp/discord-projects/{threadId}/` as CWD
