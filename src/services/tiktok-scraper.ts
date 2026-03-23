import { readFileSync, existsSync, writeFileSync, mkdirSync, unlinkSync } from "fs";
import { join } from "path";
import Anthropic from "@anthropic-ai/sdk";

const COOKIES_PATH = join(import.meta.dir, "../../tiktok-cookies.json");
const CACHE_DIR = join(import.meta.dir, "../../tiktok-cache");

export interface SlideStyle {
  position: "bottom" | "center" | "top";
  fontSize: number;
  textAlign: "left" | "center" | "right";
  fontWeight: string;
  textColor: string;
  textShadow: "strong" | "medium" | "outline" | "none";
  overlayOpacity: number;
  /** Exact vertical position of text center as % of image height (0-100) */
  yPercent?: number;
  /** Exact horizontal position of text center as % of image width (0-100) */
  xPercent?: number;
}

export interface TikTokSlide {
  text: string;
  style: SlideStyle | null;
  originalImageUrl: string | null;
}

export interface TikTokCaptionSet {
  id: number;
  source: string;
  title: string;
  slides: TikTokSlide[];
}

let captionSetId = 0;
let cookiesFilePath: string | null = null;

// --- Cookie handling ---

function getCookiesPath(): string {
  if (cookiesFilePath && existsSync(cookiesFilePath)) return cookiesFilePath;

  mkdirSync(CACHE_DIR, { recursive: true });
  const netscapePath = join(CACHE_DIR, "cookies.txt");

  let raw: any[] | null = null;
  if (process.env.TIKTOK_COOKIES_B64) {
    raw = JSON.parse(Buffer.from(process.env.TIKTOK_COOKIES_B64, "base64").toString("utf-8"));
  } else if (existsSync(COOKIES_PATH)) {
    raw = JSON.parse(readFileSync(COOKIES_PATH, "utf-8"));
  }

  if (!raw) {
    throw new Error("No TikTok cookies found. Set TIKTOK_COOKIES_B64 env var or provide tiktok-cookies.json");
  }

  const lines = ["# Netscape HTTP Cookie File"];
  for (const c of raw) {
    const domain = c.domain || "";
    const flag = domain.startsWith(".") ? "TRUE" : "FALSE";
    const path = c.path || "/";
    const secure = c.secure ? "TRUE" : "FALSE";
    const expires = String(Math.floor(c.expirationDate || 0));
    lines.push(`${domain}\t${flag}\t${path}\t${secure}\t${expires}\t${c.name}\t${c.value}`);
  }
  writeFileSync(netscapePath, lines.join("\n") + "\n");
  cookiesFilePath = netscapePath;
  return netscapePath;
}

// --- gallery-dl ---

async function galleryDlJson(url: string): Promise<any[]> {
  const args = ["gallery-dl", "--dump-json"];

  // Cookies are optional — gallery-dl works without them for public posts
  try {
    const cookies = getCookiesPath();
    args.push("--cookies", cookies);
  } catch {
    console.log("[gallery-dl] No cookies configured, proceeding without auth");
  }

  args.push(url);
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0 && !stdout.trim()) {
    console.error(`gallery-dl error: ${stderr}`);
    throw new Error(`gallery-dl failed: ${stderr.split("\n").pop()}`);
  }

  if (stderr) {
    for (const line of stderr.split("\n").filter(Boolean)) {
      console.log(`[gallery-dl] ${line}`);
    }
  }

  return JSON.parse(stdout);
}

// --- Image download ---

async function downloadImage(url: string, destPath: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      headers: { Referer: "https://www.tiktok.com/" },
    });
    if (!res.ok) return false;
    const buf = await res.arrayBuffer();
    await Bun.write(destPath, buf);
    return true;
  } catch {
    return false;
  }
}

// --- Vision-based text extraction (Claude) ---

interface ExtractedSlideData {
  text: string;
  yPercent: number;
  xPercent: number;
  textAlign: "left" | "center" | "right";
  fontSize: number;
  fontWeight: string;
  textColor: string;
}

/**
 * Use Claude vision to extract text with exact formatting from a slide image.
 * Returns text with original line breaks, position, font size, alignment, and color.
 */
async function extractTextWithVision(imageBase64: string, mimeType: string): Promise<ExtractedSlideData | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;

  const client = new Anthropic();
  try {
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 512,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mimeType as "image/jpeg", data: imageBase64 },
          },
          {
            type: "text",
            text: `Extract the overlay text from this TikTok slide image. Return ONLY a JSON object with these fields:
- "text": the exact text with line breaks preserved as \\n (include ALL text, headers and body)
- "yPercent": vertical position of the TOP of the text as a percentage of image height (0=top, 100=bottom)
- "xPercent": horizontal anchor position as percentage of image width
- "textAlign": "left", "center", or "right"
- "fontSize": estimated font size in pixels relative to a 400px wide image
- "fontWeight": "400" for regular, "600" for semi-bold, "700" for bold
- "textColor": hex color of the text (e.g. "#ffffff", "#ff2d55")

Return ONLY valid JSON, no markdown or explanation.`
          }
        ],
      }],
    });

    const raw = (response.content[0] as { type: string; text: string }).text.trim();
    // Parse JSON, handling potential markdown wrapping
    const jsonStr = raw.replace(/^```json?\n?/, "").replace(/\n?```$/, "").trim();
    const parsed = JSON.parse(jsonStr);

    return {
      text: parsed.text || "",
      yPercent: parsed.yPercent ?? 60,
      xPercent: parsed.xPercent ?? 50,
      textAlign: parsed.textAlign || "center",
      fontSize: parsed.fontSize ?? 14,
      fontWeight: parsed.fontWeight || "600",
      textColor: parsed.textColor || "#ffffff",
    };
  } catch (err) {
    console.error(`  [vision] Error: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Extract text + formatting from all slides using Claude vision.
 * Downloads each image, sends to Claude Haiku for exact text extraction.
 */
async function extractSlideText(slides: TikTokSlide[]): Promise<void> {
  const useVision = !!process.env.ANTHROPIC_API_KEY;

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    if (!slide.originalImageUrl) continue;

    try {
      // Download image to memory
      const res = await fetch(slide.originalImageUrl, {
        headers: { Referer: "https://www.tiktok.com/" },
      });
      if (!res.ok) {
        console.log(`  [extract] Slide ${i + 1}: download failed`);
        continue;
      }

      const buf = Buffer.from(await res.arrayBuffer());
      const base64 = buf.toString("base64");
      const mimeType = res.headers.get("content-type") || "image/jpeg";

      if (useVision) {
        const result = await extractTextWithVision(base64, mimeType);
        if (result && result.text) {
          slide.text = result.text;

          let position: "top" | "center" | "bottom";
          if (result.yPercent < 33) position = "top";
          else if (result.yPercent < 66) position = "center";
          else position = "bottom";

          slide.style = {
            position,
            fontSize: result.fontSize,
            textAlign: result.textAlign,
            fontWeight: result.fontWeight,
            textColor: result.textColor,
            textShadow: "medium",
            overlayOpacity: 0.4,
            yPercent: result.yPercent,
            xPercent: result.xPercent,
          };
          console.log(`  [vision] Slide ${i + 1}: "${result.text.substring(0, 50).replace(/\n/g, '↵')}" (${result.textColor}, ${result.fontWeight}, y=${result.yPercent}%)`);
          continue;
        }
      }

      // No vision available or it failed — slide gets no text
      console.log(`  [extract] Slide ${i + 1}: ${useVision ? 'vision failed' : 'no API key'} — skipped`);
    } catch (err) {
      console.log(`  [extract] Slide ${i + 1}: error — ${(err as Error).message}`);
    }
  }
}

// --- LLM cleanup ---

// --- Parse gallery-dl output ---

function parseGalleryDlEntries(entries: any[], sourceUrl: string): TikTokCaptionSet[] {
  const sets: TikTokCaptionSet[] = [];
  let currentSet: TikTokCaptionSet | null = null;

  for (const entry of entries) {
    const type = entry[0];

    if (type === 2) {
      if (currentSet && currentSet.slides.length > 0) {
        sets.push(currentSet);
      }
      const meta = entry[1];
      currentSet = {
        id: captionSetId++,
        source: sourceUrl,
        title: meta.desc || "",
        slides: [],
      };
    } else if (type === 3) {
      const url = entry[1];
      if (typeof url === "string" && isImageUrl(url)) {
        if (!currentSet) {
          currentSet = {
            id: captionSetId++,
            source: sourceUrl,
            title: "",
            slides: [],
          };
        }
        currentSet.slides.push({
          text: "",
          style: null,
          originalImageUrl: url,
        });
      }
    }
  }

  if (currentSet && currentSet.slides.length > 0) {
    sets.push(currentSet);
  }

  return sets;
}

function isImageUrl(url: string): boolean {
  const lower = url.toLowerCase();
  return (
    lower.includes(".jpg") ||
    lower.includes(".jpeg") ||
    lower.includes(".png") ||
    lower.includes(".webp") ||
    lower.includes("photomode")
  );
}

// --- Public API ---

export async function scrapeTikTokPost(
  postUrl: string
): Promise<{ sets: TikTokCaptionSet[] }> {
  console.log(`[scrape] Post: ${postUrl}`);
  const entries = await galleryDlJson(postUrl);
  const sets = parseGalleryDlEntries(entries, postUrl);

  for (const set of sets) {
    console.log(`[extract] Reading text from ${set.slides.length} slides...`);
    await extractSlideText(set.slides);
  }

  const total = sets.reduce((n, s) => n + s.slides.length, 0);
  const withText = sets.reduce((n, s) => n + s.slides.filter(sl => sl.text).length, 0);
  console.log(`[scrape] Done: ${sets.length} set(s), ${total} slides, ${withText} with text`);
  return { sets };
}

export async function scrapeTikTokProfile(
  profileUrl: string
): Promise<{ sets: TikTokCaptionSet[] }> {
  // gallery-dl returns redirects for bare profile URLs — need /posts suffix
  let postsUrl = profileUrl.replace(/\/$/, "");
  if (!postsUrl.endsWith("/posts")) postsUrl += "/posts";
  console.log(`[scrape] Profile: ${postsUrl}`);
  const entries = await galleryDlJson(postsUrl);
  const sets = parseGalleryDlEntries(entries, profileUrl);
  const slideshowSets = sets.filter(s => s.slides.length > 1);
  const total = slideshowSets.reduce((n, s) => n + s.slides.length, 0);

  // Profile scrapes skip OCR — too many slides. OCR runs on individual post scrapes.
  console.log(`[scrape] Done: ${slideshowSets.length} slideshows, ${total} slides (OCR skipped for profile)`);
  return { sets: slideshowSets };
}

// CLI test
if (import.meta.main) {
  const url = process.argv[2] || "https://www.tiktok.com/@beaublissx";
  console.log(`Scraping: ${url}`);

  const isProfile = /tiktok\.com\/@[\w.]+\/?$/.test(url);
  const result = isProfile
    ? await scrapeTikTokProfile(url)
    : await scrapeTikTokPost(url);

  console.log(JSON.stringify(result, null, 2));
}
