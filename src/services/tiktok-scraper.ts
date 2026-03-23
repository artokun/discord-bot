import puppeteer, { type Browser, type Page, type Cookie } from "puppeteer-core";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH
  || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const COOKIES_PATH = join(import.meta.dir, "../../tiktok-cookies.json");

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
let cachedCookies: Cookie[] | null = null;

function loadCookies(cookiePath?: string): Cookie[] {
  // Try env var first (base64 encoded), then file
  let raw: any[];
  if (process.env.TIKTOK_COOKIES_B64) {
    raw = JSON.parse(Buffer.from(process.env.TIKTOK_COOKIES_B64, "base64").toString("utf-8"));
  } else {
    const path = cookiePath || COOKIES_PATH;
    if (!existsSync(path)) throw new Error(`Cookie file not found: ${path}. Set TIKTOK_COOKIES_B64 env var or provide the file.`);
    raw = JSON.parse(readFileSync(path, "utf-8"));
  }

  // Convert from browser extension export format to Puppeteer format
  return raw.map((c: any) => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || "/",
    httpOnly: c.httpOnly || false,
    secure: c.secure || false,
    sameSite: c.sameSite === "no_restriction" ? "None" : c.sameSite === "lax" ? "Lax" : "Strict",
    ...(c.expirationDate ? { expires: c.expirationDate } : {}),
  }));
}

async function createBrowser(): Promise<Browser> {
  return puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-extensions",
      "--disable-blink-features=AutomationControlled",
      "--no-zygote",
      "--window-size=1280,900",
    ],
    protocolTimeout: 60000,
  });
}

async function setupPage(browser: Browser, cookies: Cookie[]): Promise<Page> {
  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  );

  // Set cookies before navigating
  await page.setCookie(...cookies);

  return page;
}

export async function scrapeTikTokProfile(
  profileUrl: string,
  cookiePath?: string
): Promise<{ sets: TikTokCaptionSet[] }> {
  if (!cachedCookies) {
    cachedCookies = loadCookies(cookiePath);
  }

  const browser = await createBrowser();

  try {
    const page = await setupPage(browser, cachedCookies);

    // Navigate to profile
    await page.setExtraHTTPHeaders({ "Referer": "https://www.tiktok.com/" });
    await page.goto(profileUrl, { waitUntil: "networkidle2", timeout: 60000 }).catch(async (e: any) => {
      if (e.message?.includes("ERR_ABORTED")) {
        await new Promise((r) => setTimeout(r, 5000));
      } else {
        throw e;
      }
    });

    // Wait for video grid to load
    await page.waitForSelector('[data-e2e="user-post-item"], [class*="DivItemContainer"]', {
      timeout: 60000,
    }).catch(() => null);

    // Scroll down to load more posts
    await autoScroll(page, 3);

    // Extract post links from the page
    const postLinks = await page.evaluate(() => {
      const links: string[] = [];
      // Find all post links in the video grid
      const anchors = document.querySelectorAll('a[href*="/video/"], a[href*="/photo/"]');
      anchors.forEach((a) => {
        const href = (a as HTMLAnchorElement).href;
        if (href && !links.includes(href)) links.push(href);
      });
      return links;
    });

    console.log(`Found ${postLinks.length} post links`);

    // Filter to slideshow posts only (photo URLs)
    const photoLinks = postLinks.filter((l) => l.includes("/photo/"));
    const videoLinks = postLinks.filter((l) => l.includes("/video/"));
    console.log(`  ${photoLinks.length} slideshows, ${videoLinks.length} videos`);

    // Close the profile page to free memory
    await page.close();

    // Scrape slideshow posts using a single reusable page
    const sets: TikTokCaptionSet[] = [];
    const limit = Math.min(photoLinks.length, 20);
    const scrapePage = await setupPage(browser, cachedCookies!);

    for (let i = 0; i < limit; i++) {
      const link = photoLinks[i];
      console.log(`Scraping ${i + 1}/${limit}: ${link}`);
      try {
        const set = await scrapePostPage(scrapePage, link);
        if (set) sets.push(set);
      } catch (e) {
        console.error(`  Failed: ${(e as Error).message}`);
        // If the page crashed, create a new one
        try {
          await scrapePage.close();
        } catch {}
        try {
          const newPage = await setupPage(browser, cachedCookies!);
          Object.assign(scrapePage, newPage);
        } catch {
          console.error("  Browser crashed, stopping");
          break;
        }
      }
    }

    try { await scrapePage.close(); } catch {}

    return { sets };
  } finally {
    await browser.close();
  }
}

export async function scrapeTikTokPost(
  postUrl: string,
  cookiePath?: string
): Promise<{ sets: TikTokCaptionSet[] }> {
  if (!cachedCookies) {
    cachedCookies = loadCookies(cookiePath);
  }

  const browser = await createBrowser();

  try {
    const page = await setupPage(browser, cachedCookies);
    const set = await scrapePostPage(page, postUrl);
    return { sets: set ? [set] : [] };
  } finally {
    await browser.close();
  }
}

async function scrapePostPage(
  page: Page,
  postUrl: string
): Promise<TikTokCaptionSet | null> {
  // Navigate to the post
  await page.setExtraHTTPHeaders({ "Referer": "https://www.tiktok.com/" });
  try {
    await page.goto(postUrl, { waitUntil: "networkidle2", timeout: 60000 });
  } catch (e: any) {
    if (!e.message?.includes("ERR_ABORTED") && !e.message?.includes("net::ERR")) {
      throw e;
    }
    // ERR_ABORTED is common — page may still be usable
    console.log(`  Navigation aborted, waiting for render...`);
  }

  // Wait for the swiper/carousel to render
  await page.waitForSelector('.swiper-slide img, img[class*="ImgPhotoSlide"], img[class*="ImgPhoto"]', {
    timeout: 15000,
  }).catch(() => null);

  // Extra wait for all slides to load into the swiper DOM
  await new Promise((r) => setTimeout(r, 3000));

  // Extract slide images and description from rendered DOM
  const result = await page.evaluate(() => {
    // Get description
    const descEl = document.querySelector(
      '[data-e2e="browse-video-desc"], [data-e2e="video-desc"], [class*="SpanText"]'
    );
    const desc = descEl?.textContent?.trim() || "";

    // Strategy 1: Non-duplicate swiper slides (best — gets exact slide count)
    const swiperImgs = document.querySelectorAll(
      '.swiper-slide:not(.swiper-slide-duplicate) img[class*="ImgPhoto"]'
    );
    if (swiperImgs.length > 0) {
      const urls: string[] = [];
      swiperImgs.forEach(img => {
        const src = (img as HTMLImageElement).src;
        if (src && !urls.includes(src)) urls.push(src);
      });
      return { desc, images: urls, method: 'swiper-dedup' };
    }

    // Strategy 2: All ImgPhoto images, deduplicated by URL
    const photoImgs = document.querySelectorAll('img[class*="ImgPhoto"]');
    if (photoImgs.length > 0) {
      const urls: string[] = [];
      photoImgs.forEach(img => {
        const src = (img as HTMLImageElement).src;
        if (src && !urls.includes(src)) urls.push(src);
      });
      return { desc, images: urls, method: 'imgphoto-dedup' };
    }

    // Strategy 3: Any large images on the page
    const urls: string[] = [];
    document.querySelectorAll('img').forEach(img => {
      const src = img.src;
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (src && w > 300 && h > 300 &&
          !src.includes('avatar') && !src.includes('static') &&
          !src.includes('music') && !urls.includes(src)) {
        urls.push(src);
      }
    });
    return { desc, images: urls, method: 'large-imgs' };
  });

  console.log(`  ${result.method}: ${result.images.length} images, desc: "${result.desc.substring(0, 50)}"`);

  if (result.images.length > 0) {
    return {
      id: captionSetId++,
      source: postUrl,
      title: result.desc,
      slides: result.images.map((url) => ({
        text: "",
        style: null,
        originalImageUrl: url,
      })),
    };
  }

  if (!result.desc) return null;
  return {
    id: captionSetId++,
    source: postUrl,
    title: result.desc,
    slides: [{ text: result.desc, style: null, originalImageUrl: null }],
  };
}


async function autoScroll(page: Page, scrolls: number) {
  for (let i = 0; i < scrolls; i++) {
    await page.evaluate(() => window.scrollBy(0, window.innerHeight));
    await new Promise((r) => setTimeout(r, 1500));
  }
}

// CLI test
if (import.meta.main) {
  const url = process.argv[2] || "https://www.tiktok.com/@beaublissx";
  const debug = process.argv.includes("--debug");
  const cookiePath = process.argv[3] === "--debug" ? undefined : process.argv[3];

  console.log(`Scraping: ${url}`);

  if (debug) {
    // Debug mode: dump raw SSR data for a single post
    const cookies = loadCookies(cookiePath);
    const browser = await createBrowser();
    const page = await setupPage(browser, cookies);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

    const rawData = await page.evaluate(() => {
      const el = document.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
      if (!el) return null;
      try {
        const data = JSON.parse(el.textContent || "");
        const ds = data["__DEFAULT_SCOPE__"] || {};
        const detail = ds["webapp.video-detail"] || {};
        const item = detail?.itemInfo?.itemStruct;
        if (!item) return { keys: Object.keys(ds), detailKeys: Object.keys(detail) };
        return {
          desc: item.desc,
          hasImagePost: !!item.imagePost,
          imagePostKeys: item.imagePost ? Object.keys(item.imagePost) : [],
          imageCount: item.imagePost?.images?.length || 0,
          itemKeys: Object.keys(item).filter((k: string) =>
            ["image", "photo", "slide", "carousel", "pic"].some((p) => k.toLowerCase().includes(p))
          ),
          allKeys: Object.keys(item),
        };
      } catch { return null; }
    });

    console.log("RAW SSR:", JSON.stringify(rawData, null, 2));
    await browser.close();
  } else {
    const isProfile = /tiktok\.com\/@[\w.]+\/?$/.test(url);
    const result = isProfile
      ? await scrapeTikTokProfile(url, cookiePath)
      : await scrapeTikTokPost(url, cookiePath);

    console.log(JSON.stringify(result, null, 2));
  }
}
