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
  const cookies = getCookiesPath();
  const proc = Bun.spawn(
    ["gallery-dl", "--cookies", cookies, "--dump-json", url],
    { stdout: "pipe", stderr: "pipe" }
  );

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

// --- Multi-pass OCR ---

interface OcrStrategy {
  name: string;
  /** ffmpeg -vf filter string */
  filter: string;
}

const OCR_STRATEGIES: OcrStrategy[] = [
  // Pass 1: white text — negate + aggressive binarize
  { name: "white-text", filter: "negate,curves=all='0/0 0.3/1 1/1'" },
  // Pass 2: colored/dark text — high contrast without negate
  { name: "color-text", filter: "eq=contrast=3:brightness=-0.3" },
  // Pass 3: colored text — grayscale + strong threshold
  { name: "gray-thresh", filter: "format=gray,negate,eq=contrast=3" },
];

async function runTesseract(imagePath: string, cwd: string): Promise<string> {
  const fileName = imagePath.split("/").pop()!;
  const tess = Bun.spawn(
    ["tesseract", fileName, "stdout", "--psm", "3"],
    { stdout: "pipe", stderr: "pipe", cwd }
  );
  const raw = await new Response(tess.stdout).text();
  await tess.exited;
  return raw;
}

function cleanOcrText(raw: string): string {
  const lines = raw.split("\n").map(l => l.trim()).filter(Boolean);
  const clean = lines.filter(l => {
    const alphaCount = (l.match(/[a-zA-Z]/g) || []).length;
    return alphaCount >= 2 && l.length > 2;
  });
  return clean.map(l => l.replace(/^[^a-zA-Z"'(]+/, "").trim()).filter(Boolean).join("\n");
}

/**
 * Multi-pass OCR: tries multiple preprocessing strategies and picks the best result.
 */
async function ocrImage(imagePath: string): Promise<string> {
  const tmpDir = join(CACHE_DIR, "ocr-tmp");
  mkdirSync(tmpDir, { recursive: true });
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const preprocessedFiles: string[] = [];

  try {
    let bestText = "";

    for (const strategy of OCR_STRATEGIES) {
      const outFile = join(tmpDir, `${id}_${strategy.name}.png`);
      preprocessedFiles.push(outFile);

      const ffmpeg = Bun.spawn(
        ["ffmpeg", "-y", "-i", imagePath, "-vf", strategy.filter, outFile],
        { stdout: "pipe", stderr: "pipe" }
      );
      await ffmpeg.exited;

      const raw = await runTesseract(outFile, tmpDir);
      const text = cleanOcrText(raw);

      if (text.length > bestText.length) {
        bestText = text;
      }

      // If we got a decent result, stop early
      if (bestText.length > 10) break;
    }

    return bestText;
  } finally {
    for (const f of preprocessedFiles) {
      try { unlinkSync(f); } catch {}
    }
  }
}

/**
 * Download + OCR all slides in a set.
 */
async function ocrSlides(slides: TikTokSlide[]): Promise<void> {
  const tmpDir = join(CACHE_DIR, "dl-tmp");
  mkdirSync(tmpDir, { recursive: true });

  const tasks = slides.map(async (slide, i) => {
    if (!slide.originalImageUrl) return;

    const imgPath = join(tmpDir, `slide_${Date.now()}_${i}.jpg`);
    try {
      const ok = await downloadImage(slide.originalImageUrl, imgPath);
      if (!ok) {
        console.log(`  [ocr] Failed to download slide ${i + 1}`);
        return;
      }

      const text = await ocrImage(imgPath);
      if (text) {
        slide.text = text;
        console.log(`  [ocr] Slide ${i + 1}: "${text.substring(0, 60)}"`);
      } else {
        console.log(`  [ocr] Slide ${i + 1}: (no text detected)`);
      }
    } finally {
      try { unlinkSync(imgPath); } catch {}
    }
  });

  // Process 3 at a time
  for (let i = 0; i < tasks.length; i += 3) {
    await Promise.all(tasks.slice(i, i + 3));
  }
}

// --- LLM cleanup ---

/**
 * Use Claude Haiku to clean up OCR artifacts and make captions grammatically correct.
 * Falls back to raw OCR text if no API key or on error.
 */
async function cleanupCaptionsWithLlm(sets: TikTokCaptionSet[]): Promise<void> {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.log("[llm] No ANTHROPIC_API_KEY set, skipping LLM cleanup");
    return;
  }

  const client = new Anthropic();

  // Build a batch request: all slides that have OCR text
  const slideEntries: { setIdx: number; slideIdx: number; raw: string }[] = [];
  for (let si = 0; si < sets.length; si++) {
    for (let sli = 0; sli < sets[si].slides.length; sli++) {
      const text = sets[si].slides[sli].text;
      if (text) {
        slideEntries.push({ setIdx: si, slideIdx: sli, raw: text });
      }
    }
  }

  if (slideEntries.length === 0) return;

  const numbered = slideEntries.map((e, i) => `${i + 1}. ${e.raw}`).join("\n");

  try {
    console.log(`[llm] Cleaning ${slideEntries.length} captions...`);
    const response = await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: `These are captions extracted via OCR from TikTok slideshow images. They have OCR artifacts like:
- Missing spaces between words
- Random noise characters at the start
- Pipe "|" instead of "I"
- Truncated endings
- Wrong line breaks

Clean each caption: fix spelling, grammar, spacing, and punctuation. Keep the original meaning and casual tone (don't make them formal). Each caption should be a single line.

Return ONLY a numbered list matching the input numbers, one cleaned caption per line. No explanations.

${numbered}`
      }],
    });

    const output = (response.content[0] as { type: string; text: string }).text;
    const lines = output.split("\n").filter(l => /^\d+\./.test(l.trim()));

    for (const line of lines) {
      const match = line.match(/^(\d+)\.\s*(.+)/);
      if (!match) continue;
      const idx = parseInt(match[1]) - 1;
      const cleaned = match[2].trim();
      if (idx >= 0 && idx < slideEntries.length && cleaned) {
        const entry = slideEntries[idx];
        sets[entry.setIdx].slides[entry.slideIdx].text = cleaned;
      }
    }
    console.log(`[llm] Cleaned ${lines.length} captions`);
  } catch (err) {
    console.error(`[llm] Cleanup failed, keeping raw OCR:`, (err as Error).message);
  }
}

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
    console.log(`[ocr] Running OCR on ${set.slides.length} slides...`);
    await ocrSlides(set.slides);
  }

  await cleanupCaptionsWithLlm(sets);

  const total = sets.reduce((n, s) => n + s.slides.length, 0);
  const withText = sets.reduce((n, s) => n + s.slides.filter(sl => sl.text).length, 0);
  console.log(`[scrape] Done: ${sets.length} set(s), ${total} slides, ${withText} with text`);
  return { sets };
}

export async function scrapeTikTokProfile(
  profileUrl: string
): Promise<{ sets: TikTokCaptionSet[] }> {
  console.log(`[scrape] Profile: ${profileUrl}`);
  const entries = await galleryDlJson(profileUrl);
  const sets = parseGalleryDlEntries(entries, profileUrl);
  const slideshowSets = sets.filter(s => s.slides.length > 1);

  for (const set of slideshowSets) {
    console.log(`[ocr] Running OCR on ${set.slides.length} slides...`);
    await ocrSlides(set.slides);
  }

  await cleanupCaptionsWithLlm(slideshowSets);

  const total = slideshowSets.reduce((n, s) => n + s.slides.length, 0);
  const withText = slideshowSets.reduce((n, s) => n + s.slides.filter(sl => sl.text).length, 0);
  console.log(`[scrape] Done: ${slideshowSets.length} slideshows, ${total} slides, ${withText} with text`);
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
