// Vercel serverless function: proxies TikTok CDN images to bypass referrer restrictions
export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const imageUrl = url.searchParams.get("url");

  if (!imageUrl || !imageUrl.includes("tiktok")) {
    return new Response(JSON.stringify({ error: "Missing or invalid url param" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const res = await fetch(imageUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      "Referer": "https://www.tiktok.com/",
    },
  });

  if (!res.ok) {
    return new Response(JSON.stringify({ error: "Failed to fetch image" }), {
      status: 502,
      headers: { "Content-Type": "application/json" },
    });
  }

  return new Response(res.body, {
    headers: {
      "Content-Type": res.headers.get("Content-Type") || "image/jpeg",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export const config = { runtime: "edge" };
