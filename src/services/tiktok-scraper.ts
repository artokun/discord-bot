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

// --- Multi-pass OCR ---

interface OcrStrategy {
  name: string;
  /** ffmpeg -vf filter string */
  filter: string;
}

// Scale down to 800px wide first to reduce memory, then preprocess
const SCALE = "scale=800:-1,";

const OCR_STRATEGIES: OcrStrategy[] = [
  // Pass 1: white text — negate + aggressive binarize
  { name: "white-text", filter: `${SCALE}negate,curves=all='0/0 0.3/1 1/1'` },
  // Pass 2: colored/dark text — high contrast without negate
  { name: "color-text", filter: `${SCALE}eq=contrast=3:brightness=-0.3` },
  // Pass 3: colored text — grayscale + strong threshold
  { name: "gray-thresh", filter: `${SCALE}format=gray,negate,eq=contrast=3` },
];

interface OcrResult {
  text: string;
  /** Text block center Y as percentage of image height (0-100) */
  yPercent: number;
  /** Text block center X as percentage of image width (0-100) */
  xPercent: number;
  /** Text horizontal alignment: "left" | "center" | "right" */
  textAlign: "left" | "center" | "right";
  /** Estimated font size, calibrated to 400px reference width (for the frontend scaler) */
  fontSize: number;
}

async function runTesseractTsv(imagePath: string, cwd: string): Promise<string> {
  const fileName = imagePath.split("/").pop()!;
  const tess = Bun.spawn(
    ["tesseract", fileName, "stdout", "--psm", "3", "tsv"],
    { stdout: "pipe", stderr: "pipe", cwd }
  );
  const raw = await new Response(tess.stdout).text();
  await tess.exited;
  return raw;
}

function parseTsvOutput(tsv: string, imgWidth: number, imgHeight: number): OcrResult {
  const lines = tsv.trim().split("\n");
  if (lines.length < 2) return { text: "", yPercent: 70, textAlign: "center" };

  // Extract words with positions
  const words: { text: string; left: number; top: number; w: number; h: number; lineNum: string }[] = [];
  for (const line of lines.slice(1)) {
    const parts = line.split("\t");
    if (parts.length < 12) continue;
    const level = parseInt(parts[0]);
    const text = parts[11]?.trim();
    if (level !== 5 || !text) continue;
    const alphaCount = (text.match(/[a-zA-Z]/g) || []).length;
    if (alphaCount < 1) continue;
    words.push({
      text,
      left: parseInt(parts[6]),
      top: parseInt(parts[7]),
      w: parseInt(parts[8]),
      h: parseInt(parts[9]),
      lineNum: parts[4],
    });
  }

  if (words.length === 0) return { text: "", yPercent: 70, textAlign: "center" };

  // Group words into text lines
  const lineGroups = new Map<string, typeof words>();
  for (const w of words) {
    const group = lineGroups.get(w.lineNum) || [];
    group.push(w);
    lineGroups.set(w.lineNum, group);
  }

  const textLines: string[] = [];
  let allLeft: number[] = [];
  let allRight: number[] = [];
  let allWordHeights: number[] = [];
  let minTop = Infinity;
  let maxBottom = 0;

  for (const group of lineGroups.values()) {
    const lineText = group.map(w => w.text).join(" ");
    // Filter noise lines
    const alphaCount = (lineText.match(/[a-zA-Z]/g) || []).length;
    if (alphaCount < 2 || lineText.length < 3) continue;
    const cleaned = lineText.replace(/^[^a-zA-Z"'(]+/, "").trim();
    if (!cleaned) continue;

    textLines.push(cleaned);
    const x1 = Math.min(...group.map(w => w.left));
    const x2 = Math.max(...group.map(w => w.left + w.w));
    const y1 = Math.min(...group.map(w => w.top));
    const y2 = Math.max(...group.map(w => w.top + w.h));
    allLeft.push(x1);
    allRight.push(x2);
    minTop = Math.min(minTop, y1);
    maxBottom = Math.max(maxBottom, y2);
    // Collect word heights for font size estimation (skip very small words like "i")
    for (const w of group) {
      if (w.h > 10 && w.text.length > 1) allWordHeights.push(w.h);
    }
  }

  if (textLines.length === 0) return { text: "", yPercent: 70, xPercent: 50, textAlign: "center", fontSize: 32 };

  // Calculate vertical position (center of text block)
  const textCenterY = (minTop + maxBottom) / 2;
  const yPercent = Math.round((textCenterY / imgHeight) * 100);

  // Calculate horizontal alignment
  const avgLeft = allLeft.reduce((a, b) => a + b, 0) / allLeft.length;
  const avgRight = allRight.reduce((a, b) => a + b, 0) / allRight.length;
  const textCenterX = (avgLeft + avgRight) / 2;
  const xPercentRaw = textCenterX / imgWidth;
  const xPercent = Math.round(xPercentRaw * 100);

  let textAlign: "left" | "center" | "right";
  if (xPercentRaw < 0.38) textAlign = "left";
  else if (xPercentRaw > 0.62) textAlign = "right";
  else textAlign = "center";

  // Estimate font size from word heights
  // Word height ≈ cap height. Font size ≈ word height * 1.15 (ascender ratio)
  // Frontend scales: scaledFontSize = fontSize * (canvasWidth / 400)
  // OCR was done at SCALED_W (800px), so: fontSize = wordHeight * 1.15 * (400 / 800)
  const REFERENCE_WIDTH = 400; // frontend reference width
  let fontSize = 32; // default
  if (allWordHeights.length > 0) {
    allWordHeights.sort((a, b) => a - b);
    const medianHeight = allWordHeights[Math.floor(allWordHeights.length / 2)];
    fontSize = Math.round(medianHeight * 1.15 * (REFERENCE_WIDTH / imgWidth));
  }

  return {
    text: textLines.join("\n"),
    yPercent,
    xPercent,
    textAlign,
    fontSize,
  };
}

/**
 * Multi-pass OCR: tries multiple preprocessing strategies and picks the best result.
 * Returns text + position data (vertical %, horizontal alignment).
 */
async function ocrImage(imagePath: string): Promise<OcrResult> {
  const tmpDir = join(CACHE_DIR, "ocr-tmp");
  mkdirSync(tmpDir, { recursive: true });
  const id = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const preprocessedFiles: string[] = [];
  // Scaled image dimensions (SCALE = 800px wide, height proportional)
  const SCALED_W = 800;
  // Approximate TikTok aspect ratio 9:16
  const SCALED_H = Math.round(SCALED_W * (16 / 9));

  try {
    let best: OcrResult = { text: "", yPercent: 70, textAlign: "center" };

    for (const strategy of OCR_STRATEGIES) {
      const outFile = join(tmpDir, `${id}_${strategy.name}.png`);
      preprocessedFiles.push(outFile);

      const ffmpeg = Bun.spawn(
        ["ffmpeg", "-y", "-i", imagePath, "-vf", strategy.filter, outFile],
        { stdout: "pipe", stderr: "pipe" }
      );
      await ffmpeg.exited;

      const tsv = await runTesseractTsv(outFile, tmpDir);
      const result = parseTsvOutput(tsv, SCALED_W, SCALED_H);

      if (result.text.length > best.text.length) {
        best = result;
      }

      if (best.text.length > 10) break;
    }

    return best;
  } finally {
    for (const f of preprocessedFiles) {
      try { unlinkSync(f); } catch {}
    }
  }
}

/**
 * Download + OCR all slides in a set.
 * Processes one at a time to keep memory low on small containers.
 */
async function ocrSlides(slides: TikTokSlide[]): Promise<void> {
  const tmpDir = join(CACHE_DIR, "dl-tmp");
  mkdirSync(tmpDir, { recursive: true });

  for (let i = 0; i < slides.length; i++) {
    const slide = slides[i];
    if (!slide.originalImageUrl) continue;

    const imgPath = join(tmpDir, `slide_${i}.jpg`);
    try {
      const ok = await downloadImage(slide.originalImageUrl, imgPath);
      if (!ok) {
        console.log(`  [ocr] Failed to download slide ${i + 1}`);
        continue;
      }

      const result = await ocrImage(imgPath);
      if (result.text) {
        slide.text = result.text;
        // Map yPercent to position zone
        let position: "top" | "center" | "bottom";
        if (result.yPercent < 33) position = "top";
        else if (result.yPercent < 66) position = "center";
        else position = "bottom";

        slide.style = {
          position,
          fontSize: result.fontSize,
          textAlign: result.textAlign,
          fontWeight: "600",
          textColor: "#ffffff",
          textShadow: "medium",
          overlayOpacity: 0.4,
          yPercent: result.yPercent,
          xPercent: result.xPercent,
        };
        console.log(`  [ocr] Slide ${i + 1}: "${result.text.substring(0, 50)}" (x=${result.xPercent}%, y=${result.yPercent}%)`);
      } else {
        console.log(`  [ocr] Slide ${i + 1}: (no text detected)`);
      }
    } finally {
      try { unlinkSync(imgPath); } catch {}
    }
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
