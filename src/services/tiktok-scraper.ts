import { readFileSync, existsSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { $ } from "bun";

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

/**
 * Ensure we have a cookies file gallery-dl can read.
 * Accepts either a JSON cookie export or Netscape format.
 * Converts JSON to Netscape if needed.
 */
function getCookiesPath(): string {
  if (cookiesFilePath && existsSync(cookiesFilePath)) return cookiesFilePath;

  mkdirSync(CACHE_DIR, { recursive: true });
  const netscapePath = join(CACHE_DIR, "cookies.txt");

  // Try env var first (base64 encoded JSON)
  let raw: any[] | null = null;
  if (process.env.TIKTOK_COOKIES_B64) {
    raw = JSON.parse(Buffer.from(process.env.TIKTOK_COOKIES_B64, "base64").toString("utf-8"));
  } else if (existsSync(COOKIES_PATH)) {
    raw = JSON.parse(readFileSync(COOKIES_PATH, "utf-8"));
  }

  if (!raw) {
    throw new Error("No TikTok cookies found. Set TIKTOK_COOKIES_B64 env var or provide tiktok-cookies.json");
  }

  // Convert JSON cookies to Netscape format
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

/**
 * Run gallery-dl --dump-json and parse the structured output.
 * Returns post metadata + image URLs.
 */
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
    // Log warnings but don't fail
    for (const line of stderr.split("\n").filter(Boolean)) {
      console.log(`[gallery-dl] ${line}`);
    }
  }

  return JSON.parse(stdout);
}

/**
 * Download images from a TikTok post to a temp directory.
 * Returns the directory path containing the downloaded images.
 */
async function galleryDlDownload(url: string): Promise<string> {
  const cookies = getCookiesPath();
  const destDir = join(CACHE_DIR, `dl-${Date.now()}`);
  mkdirSync(destDir, { recursive: true });

  const proc = Bun.spawn(
    ["gallery-dl", "--cookies", cookies, "-d", destDir, "--no-download", url],
    { stdout: "pipe", stderr: "pipe" }
  );

  await proc.exited;
  return destDir;
}

/**
 * Parse gallery-dl JSON output into our TikTokCaptionSet format.
 * gallery-dl returns:
 *   Entry 0: [2, {metadata}]           — directory/post metadata
 *   Entry 1+: [3, "image_url", {meta}] — individual image files
 */
function parseGalleryDlEntries(entries: any[], sourceUrl: string): TikTokCaptionSet[] {
  const sets: TikTokCaptionSet[] = [];
  let currentSet: TikTokCaptionSet | null = null;

  for (const entry of entries) {
    const type = entry[0];

    if (type === 2) {
      // Directory entry = new post
      if (currentSet && currentSet.slides.length > 0) {
        sets.push(currentSet);
      }
      const meta = entry[1];
      const imagePost = meta.imagePost || {};
      const desc = meta.desc || "";
      currentSet = {
        id: captionSetId++,
        source: sourceUrl,
        title: desc,
        slides: [],
      };
    } else if (type === 3) {
      // File entry = image or audio
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
    // Type 6 = redirect entries (avatar, /posts), skip
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

export async function scrapeTikTokPost(
  postUrl: string
): Promise<{ sets: TikTokCaptionSet[] }> {
  console.log(`[gallery-dl] Scraping post: ${postUrl}`);
  const entries = await galleryDlJson(postUrl);
  const sets = parseGalleryDlEntries(entries, postUrl);
  console.log(`[gallery-dl] Got ${sets.length} set(s) with ${sets.reduce((n, s) => n + s.slides.length, 0)} total slides`);
  return { sets };
}

export async function scrapeTikTokProfile(
  profileUrl: string
): Promise<{ sets: TikTokCaptionSet[] }> {
  console.log(`[gallery-dl] Scraping profile: ${profileUrl}`);
  const entries = await galleryDlJson(profileUrl);
  const sets = parseGalleryDlEntries(entries, profileUrl);
  // Filter to only slideshow posts (sets with >1 slide)
  const slideshowSets = sets.filter(s => s.slides.length > 1);
  console.log(`[gallery-dl] Got ${sets.length} total posts, ${slideshowSets.length} slideshows`);
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
