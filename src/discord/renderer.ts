import {
  type TextChannel,
  type ThreadChannel,
  EmbedBuilder,
  AttachmentBuilder,
} from "discord.js";

const MAX_MSG_LEN = 1950; // leave margin under Discord's 2000

/**
 * Send a potentially long Claude response to a Discord channel,
 * splitting at natural boundaries and extracting large code blocks as files.
 */
export async function sendAssistantResponse(
  channel: TextChannel | ThreadChannel,
  text: string,
): Promise<void> {
  if (!text.trim()) return;

  const { chunks, files } = splitResponse(text);

  for (const chunk of chunks) {
    if (chunk.trim()) {
      await channel.send(chunk);
    }
  }

  for (const file of files) {
    await channel.send({
      content: `📎 \`${file.name}\``,
      files: [new AttachmentBuilder(Buffer.from(file.content), { name: file.name })],
    });
  }
}

interface SplitResult {
  chunks: string[];
  files: Array<{ name: string; content: string }>;
}

function splitResponse(text: string): SplitResult {
  const files: Array<{ name: string; content: string }> = [];
  let fileCounter = 0;

  // Extract large code blocks (>1500 chars) into file attachments
  const processed = text.replace(
    /```(\w*)\n([\s\S]*?)```/g,
    (_match, lang: string, code: string) => {
      if (code.length > 1500) {
        fileCounter++;
        const ext = langToExt(lang) || "txt";
        const name = `code-${fileCounter}.${ext}`;
        files.push({ name, content: code });
        return `_(see attached \`${name}\`)_`;
      }
      return _match; // Keep small code blocks inline
    },
  );

  // Split into chunks at paragraph boundaries
  const chunks = chunkText(processed, MAX_MSG_LEN);
  return { chunks, files };
}

function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to split at double newline (paragraph break)
    let splitIdx = remaining.lastIndexOf("\n\n", maxLen);
    if (splitIdx < maxLen * 0.3) {
      // Too early — try single newline
      splitIdx = remaining.lastIndexOf("\n", maxLen);
    }
    if (splitIdx < maxLen * 0.3) {
      // Still too early — hard split
      splitIdx = maxLen;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).replace(/^\n+/, "");
  }

  return chunks;
}

function langToExt(lang: string): string {
  const map: Record<string, string> = {
    typescript: "ts", ts: "ts",
    javascript: "js", js: "js",
    python: "py", py: "py",
    rust: "rs",
    go: "go",
    java: "java",
    html: "html",
    css: "css",
    json: "json",
    yaml: "yml", yml: "yml",
    bash: "sh", sh: "sh", shell: "sh",
    sql: "sql",
    markdown: "md", md: "md",
    tsx: "tsx", jsx: "jsx",
    c: "c", cpp: "cpp",
  };
  return map[lang.toLowerCase()] ?? (lang.toLowerCase() || "txt");
}

/** Create a compact embed for tool usage status */
export function toolUseEmbed(toolName: string, param: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x5865f2)
    .setDescription(`**${toolName}**\n\`${param.slice(0, 200)}\``)
    .setTimestamp();
}

/** Create an error embed */
export function errorEmbed(error: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xed4245)
    .setTitle("Error")
    .setDescription(error.slice(0, 4000))
    .setTimestamp();
}
