/**
 * Vercel Serverless Function — YouTube → MP3 bridge
 *
 * Acts as a secure middleman between the MusiMe frontend and a third-party
 * YouTube-to-MP3 REST API (RapidAPI). The API key never touches the client —
 * it lives in Vercel Environment Variables and is injected here on the server.
 *
 * Flow:
 *   POST /api/youtube-mp3  { url: "https://youtube.com/watch?v=..." }
 *   →  this function calls the RapidAPI endpoint with RAPIDAPI_KEY
 *   →  returns { success, downloadUrl, title?, thumbnail?, duration? }
 *
 * Env vars (set in Vercel → Settings → Environment Variables):
 *   RAPIDAPI_KEY   — your RapidAPI key
 *   RAPIDAPI_HOST  — the API host (e.g. youtube-mp36.p.rapidapi.com)
 *   RAPIDAPI_ENDPOINT — full endpoint URL (optional, overrides host-based default)
 */

// ── Config ───────────────────────────────────────────────────────────────────

// Default RapidAPI endpoint. Override with RAPIDAPI_ENDPOINT env var if your
// provider uses a different URL.
const DEFAULT_ENDPOINT =
  process.env.RAPIDAPI_ENDPOINT ||
  "https://youtube-mp36.p.rapidapi.com/dl";

const RAPIDAPI_HOST =
  process.env.RAPIDAPI_HOST || "youtube-mp36.p.rapidapi.com";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Validate and normalise a YouTube URL into the format the API expects.
 * Supports: youtube.com/watch?v=, youtu.be/, youtube.com/shorts/, m.youtube.com
 */
function extractVideoId(input) {
  if (!input || typeof input !== "string") return null;
  const url = input.trim();

  // Direct 11-char video ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;

  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,          // youtube.com/watch?v=ID
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,      // youtu.be/ID
    /\/shorts\/([a-zA-Z0-9_-]{11})/,        // youtube.com/shorts/ID
    /\/embed\/([a-zA-Z0-9_-]{11})/,         // youtube.com/embed/ID
  ];

  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

function json(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    body: JSON.stringify(body),
  };
}

// ── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(204).end();
  }

  if (req.method !== "POST") {
    return res.status(405).json({
      success: false,
      error: "Method not allowed. Use POST.",
    });
  }

  const apiKey = process.env.RAPIDAPI_KEY;
  if (!apiKey) {
    return res.status(500).json({
      success: false,
      error: "Server is missing RAPIDAPI_KEY environment variable.",
    });
  }

  // Parse body (Vercel may provide it as string or already-parsed object)
  let body;
  try {
    body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({
      success: false,
      error: "Invalid JSON body.",
    });
  }

  const url = body?.url || body?.videoUrl || "";
  const videoId = extractVideoId(url);

  if (!videoId) {
    return res.status(400).json({
      success: false,
      error: "Invalid YouTube URL. Paste a link like https://youtube.com/watch?v=...",
    });
  }

  // Call the RapidAPI endpoint
  const apiEndpoint = process.env.RAPIDAPI_ENDPOINT || DEFAULT_ENDPOINT;

  // Most RapidAPI YouTube-to-MP3 endpoints accept ?id=VIDEO_ID
  const requestUrl = `${apiEndpoint}?id=${encodeURIComponent(videoId)}`;

  try {
    const apiRes = await fetch(requestUrl, {
      method: "GET",
      headers: {
        "X-RapidAPI-Key": apiKey,
        "X-RapidAPI-Host": process.env.RAPIDAPI_HOST || RAPIDAPI_HOST,
      },
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text().catch(() => "");
      console.error("RapidAPI error:", apiRes.status, errText);
      return res.status(apiRes.status).json({
        success: false,
        error: `Conversion API returned ${apiRes.status}. The video may be unavailable, private, or too long.`,
      });
    }

    const data = await apiRes.json();

    // ── Response shape adaptation ─────────────────────────────────────────
    // Different RapidAPI providers return slightly different JSON shapes.
    // We try the most common ones and normalise into a single output.
    //
    // Common shapes:
    //   1. { link: "https://..." , title: "...", progress: 100, status: "ok" }
    //   2. { download: "https://..." }
    //   3. { result: { download_url: "https://..." } }
    //   4. { audiolink: "https://..." }
    //
    // We look for a URL ending in .mp3 (or containing "mp3") in known fields.
    const downloadUrl =
      data.link ||
      data.download ||
      data.download_url ||
      data.audiolink ||
      data?.result?.download_url ||
      data?.result?.link ||
      null;

    // Some APIs return a status field; if it's an error, surface the message
    const apiStatus = data.status || data?.result?.status;
    if (apiStatus && String(apiStatus).toLowerCase() === "fail") {
      return res.status(422).json({
        success: false,
        error: data.msg || data.message || "Conversion failed. Try a different video.",
      });
    }

    if (!downloadUrl || typeof downloadUrl !== "string") {
      return res.status(422).json({
        success: false,
        error: "Conversion completed but no download URL was returned. The video may be too long or restricted.",
      });
    }

    return res.status(200).json({
      success: true,
      downloadUrl,
      title: data.title || data?.result?.title || "",
      thumbnail: data.thumb || data.thumbnail || data?.result?.thumbnail || "",
      duration: data.duration || data?.result?.duration || "",
    });
  } catch (err) {
    console.error("YouTube-to-MP3 proxy error:", err);
    return res.status(502).json({
      success: false,
      error: "Could not reach the conversion API. Please try again in a moment.",
    });
  }
}
