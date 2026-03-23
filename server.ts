import { mkdirSync, rmSync, existsSync, readdirSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join, parse } from "path";

const PORT = parseInt(process.env.PORT || "3456");
const UPLOAD_DIR = join(import.meta.dir, "uploads");
const OUTPUT_DIR = join(import.meta.dir, "output");
const PUBLIC_DIR = join(import.meta.dir, "public");
const TIKTOK_CACHE_DIR = join(import.meta.dir, "tiktok-cache");

for (const dir of [UPLOAD_DIR, OUTPUT_DIR, TIKTOK_CACHE_DIR]) {
  mkdirSync(dir, { recursive: true });
}

// --- TikTok Scraping (gallery-dl) ---
import { scrapeTikTokProfile, scrapeTikTokPost } from "./src/services/tiktok-scraper";


async function scrapeTikTok(inputUrl: string) {
  const isProfile = /tiktok\.com\/@[\w.]+\/?$/.test(inputUrl);
  if (isProfile) {
    return scrapeTikTokProfile(inputUrl);
  } else {
    return scrapeTikTokPost(inputUrl);
  }
}

// Image proxy for TikTok CDN images (they require referrer headers)
async function proxyTikTokImage(imageUrl: string): Promise<Response> {
  const res = await fetch(imageUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Referer": "https://www.tiktok.com/",
    },
  });

  if (!res.ok) {
    return Response.json({ error: "Failed to fetch image" }, { status: 502 });
  }

  return new Response(res.body, {
    headers: {
      "Content-Type": res.headers.get("Content-Type") || "image/jpeg",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}



// Check ffmpeg
const ffCheck = Bun.spawnSync(["which", "ffmpeg"]);
if (ffCheck.exitCode !== 0) {
  console.error("Error: ffmpeg not found in PATH");
  process.exit(1);
}

// Check if drawtext filter is available
const hasDrawtext = (() => {
  const proc = Bun.spawnSync(["ffmpeg", "-filters"], { stdout: "pipe", stderr: "pipe" });
  return new TextDecoder().decode(proc.stdout).includes("drawtext");
})();

// Find bold font
function findBoldFont(): string | null {
  const candidates = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/Library/Fonts/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
  ];
  return candidates.find((f) => existsSync(f)) ?? null;
}

const BOLD_FONT = findBoldFont();

// --- Progress State ---
interface Progress {
  status: "idle" | "processing" | "done" | "error";
  total: number;
  completed: number;
  current: string;
  error: string;
}

let progress: Progress = {
  status: "idle",
  total: 0,
  completed: 0,
  current: "",
  error: "",
};

// --- Utils ---
function wordWrap(text: string, max = 22): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return [""];
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line && line.length + 1 + w.length > max) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function escapeDrawtext(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "\u2019")
    .replace(/:/g, "\\:")
    .replace(/;/g, "\\;")
    .replace(/%/g, "%%");
}

function buildDrawtextFilter(caption: string): string {
  // Don't use single quotes around text — \n only works as newline outside quotes
  const wrapped = wordWrap(caption, 22)
    .map((l) => escapeDrawtext(l))
    .join("\\n");
  const parts: string[] = [`drawtext=text=${wrapped}`];
  if (BOLD_FONT) {
    parts.push(`fontfile='${BOLD_FONT}'`);
  }
  parts.push("fontsize=w/18");
  parts.push("fontcolor=white");
  parts.push("bordercolor=black");
  parts.push("borderw=4");
  parts.push("x=(w-text_w)/2");
  parts.push("y=(h-text_h)/2");
  parts.push("line_spacing=10");
  return parts.join(":");
}

// Generate ASS subtitle file for caption overlay (fallback when drawtext unavailable)
function createAssFile(caption: string, outputPath: string): string {
  const lines = wordWrap(caption, 22);
  const text = lines.join("\\N");
  const fontName = BOLD_FONT ? "Arial" : "Sans";

  const ass = `[Script Info]
Title: Caption
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},90,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,4,0,5,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.00,9:59:59.99,Default,,0,0,0,,${text}
`;

  const assPath = outputPath.replace(/\.mp4$/, ".ass");
  writeFileSync(assPath, ass);
  return assPath;
}

function cleanDir(dir: string) {
  if (existsSync(dir)) rmSync(dir, { recursive: true });
  mkdirSync(dir, { recursive: true });
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function videoFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) =>
    /\.(mp4|mov|avi|mkv|webm)$/i.test(f)
  );
}

// --- Processing ---
async function processAll(videos: string[], captions: string[]) {
  progress = {
    status: "processing",
    total: videos.length * captions.length,
    completed: 0,
    current: "",
    error: "",
  };

  cleanDir(OUTPUT_DIR);

  for (const video of videos) {
    const vName = parse(video).name;
    for (let ci = 0; ci < captions.length; ci++) {
      const outName = `${vName}_caption${ci + 1}.mp4`;
      const outputPath = join(OUTPUT_DIR, outName);
      progress.current = outName;

      let args: string[];

      if (hasDrawtext) {
        const filter = buildDrawtextFilter(captions[ci]);
        args = [
          "ffmpeg", "-i", join(UPLOAD_DIR, video),
          "-vf", filter,
          "-c:v", "libx264", "-c:a", "aac", "-y", outputPath,
        ];
      } else {
        // Use ASS subtitle burn-in as fallback
        const assPath = createAssFile(captions[ci], outputPath);
        args = [
          "ffmpeg", "-i", join(UPLOAD_DIR, video),
          "-vf", `ass='${assPath.replace(/'/g, "'\\''")}'`,
          "-c:v", "libx264", "-c:a", "aac", "-y", outputPath,
        ];
      }

      const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        const err = await new Response(proc.stderr).text();
        console.error(`Failed: ${outName}`, err.slice(-300));
      }
      progress.completed++;
    }
  }

  // Create ZIP
  progress.current = "Creating ZIP...";
  const outputs = readdirSync(OUTPUT_DIR).filter((f) => f.endsWith(".mp4"));
  if (outputs.length > 0) {
    const zipProc = Bun.spawn(
      [
        "zip",
        "-j",
        join(OUTPUT_DIR, "all_videos.zip"),
        ...outputs.map((f) => join(OUTPUT_DIR, f)),
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    await zipProc.exited;
  }

  progress.status = "done";
  progress.current = "";
}

// --- Server ---
Bun.serve({
  port: PORT,
  maxRequestBodySize: 500 * 1024 * 1024,

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // Serve frontend
    if (path === "/" || path === "/index.html") {
      return new Response(Bun.file(join(PUBLIC_DIR, "index.html")), {
        headers: { "Content-Type": "text/html" },
      });
    }

    if (path === "/tiktok" || path === "/tiktok.html") {
      return new Response(Bun.file(join(PUBLIC_DIR, "tiktok.html")), {
        headers: { "Content-Type": "text/html" },
      });
    }

    // TikTok scraping endpoint
    if (path === "/api/tiktok/scrape" && req.method === "POST") {
      const { url: tiktokUrl } = (await req.json()) as { url: string };
      if (!tiktokUrl || !tiktokUrl.includes("tiktok.com")) {
        return Response.json({ error: "Invalid TikTok URL" }, { status: 400 });
      }

      try {
        const result = await scrapeTikTok(tiktokUrl);
        return Response.json(result);
      } catch (err: any) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // Proxy TikTok CDN images (they block direct browser access)
    if (path === "/api/tiktok/proxy-image" && req.method === "GET") {
      const imageUrl = url.searchParams.get("url");
      if (!imageUrl) return Response.json({ error: "Missing url param" }, { status: 400 });
      return proxyTikTokImage(imageUrl);
    }

    // Upload videos
    if (path === "/api/upload" && req.method === "POST") {
      const form = await req.formData();
      const files = form.getAll("videos");
      const uploaded: string[] = [];
      for (const f of files) {
        if (f instanceof File) {
          const name = sanitizeFilename(f.name);
          await Bun.write(join(UPLOAD_DIR, name), f);
          uploaded.push(name);
        }
      }
      return Response.json({ uploaded });
    }

    // List uploaded videos
    if (path === "/api/videos" && req.method === "GET") {
      return Response.json({ files: videoFiles(UPLOAD_DIR) });
    }

    // Delete a video
    if (path.startsWith("/api/video/") && req.method === "DELETE") {
      const name = decodeURIComponent(path.slice("/api/video/".length));
      const filePath = join(UPLOAD_DIR, name);
      if (existsSync(filePath)) {
        unlinkSync(filePath);
        return Response.json({ ok: true });
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    }

    // Start processing
    if (path === "/api/process" && req.method === "POST") {
      if (progress.status === "processing") {
        return Response.json({ error: "Already processing" }, { status: 409 });
      }
      const { captions } = (await req.json()) as { captions: string[] };
      const videos = videoFiles(UPLOAD_DIR);
      if (!videos.length)
        return Response.json({ error: "No videos uploaded" }, { status: 400 });
      if (!captions?.length)
        return Response.json(
          { error: "No captions provided" },
          { status: 400 }
        );

      processAll(videos, captions).catch((err) => {
        progress.status = "error";
        progress.error = err.message;
      });

      return Response.json({
        total: videos.length * captions.length,
        videos: videos.length,
        captions: captions.length,
      });
    }

    // Get progress
    if (path === "/api/progress" && req.method === "GET") {
      return Response.json(progress);
    }

    // Download ZIP
    if (path === "/api/download" && req.method === "GET") {
      const zipPath = join(OUTPUT_DIR, "all_videos.zip");
      if (!existsSync(zipPath))
        return Response.json({ error: "No zip available" }, { status: 404 });
      return new Response(Bun.file(zipPath), {
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": "attachment; filename=captioned_videos.zip",
        },
      });
    }

    // Download individual file
    if (path.startsWith("/api/download/") && req.method === "GET") {
      const name = decodeURIComponent(path.slice("/api/download/".length));
      const filePath = join(OUTPUT_DIR, name);
      if (!existsSync(filePath))
        return Response.json({ error: "File not found" }, { status: 404 });
      return new Response(Bun.file(filePath), {
        headers: {
          "Content-Type": "video/mp4",
          "Content-Disposition": `attachment; filename="${name}"`,
        },
      });
    }

    // List output files with sizes
    if (path === "/api/outputs" && req.method === "GET") {
      if (!existsSync(OUTPUT_DIR)) return Response.json({ files: [] });
      const files = readdirSync(OUTPUT_DIR)
        .filter((f) => f.endsWith(".mp4"))
        .map((f) => ({
          name: f,
          size: formatBytes(statSync(join(OUTPUT_DIR, f)).size),
        }));
      return Response.json({ files });
    }

    // Reset everything
    if (path === "/api/reset" && req.method === "POST") {
      cleanDir(UPLOAD_DIR);
      cleanDir(OUTPUT_DIR);
      progress = {
        status: "idle",
        total: 0,
        completed: 0,
        current: "",
        error: "",
      };
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Video Caption Generator running on http://localhost:${PORT}`);
console.log(`Font: ${BOLD_FONT ?? "ffmpeg default"}`);
