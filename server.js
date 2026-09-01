// IG Downloader Service — yt-dlp HTTP wrapper for age-restricted Instagram content.
// Deploy on Render (Pro plan). Called by Base44 backend functions as the
// age-restricted fallback when SMVD + Apify both fail.
//
// POST /fetch
//   { url: "https://www.instagram.com/reel/...", cookie: "sessionid=..." }
//   → { platform, source_url, video_url, thumbnail_url, caption, title, duration, author, slides: [] }
//   → { error: "..." } on failure (422)

const express = require('express');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 3000;
const SHARED_SECRET = process.env.SHARED_SECRET || '';
const YTDLP = process.env.YTDLP_PATH || 'yt-dlp';
const TIMEOUT_MS = 90_000; // yt-dlp can take a while on age-gated content

// Allowed Instagram domains for SSRF protection.
const ALLOWED_HOSTS = new Set([
  'instagram.com',
  'www.instagram.com',
  'instagr.am',
  'www.instagr.am',
]);

// Simple shared-secret auth. Set SHARED_SECRET in Render env vars to match
// the IG_DOWNLOADER_SECRET in Base44. If SHARED_SECRET is empty, auth is
// disabled (fine for testing, lock it down for production).
app.use((req, res, next) => {
  if (SHARED_SECRET && req.headers['x-shared-secret'] !== SHARED_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
});

// Rate limiting: 200 requests per hour per IP. Covers 3 admins × 30 URLs
// with headroom. In-memory (fine for a single-instance Render service).
const RATE_LIMIT_MAX = 200;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const rateBuckets = new Map(); // ip → { count, resetAt }

app.use((req, res, next) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  if (bucket.count > RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((bucket.resetAt - now) / 1000);
    res.setHeader('Retry-After', String(retryAfter));
    return res.status(429).json({ error: `Rate limit exceeded: ${RATE_LIMIT_MAX} requests/hour. Retry in ${retryAfter}s.` });
  }
  next();
});

function runYtDlp(args) {
  return new Promise((resolve) => {
    execFile(YTDLP, args, { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        resolve({ error: err.message, stderr: (stderr || '').slice(-500) });
      } else {
        resolve({ stdout });
      }
    });
  });
}

app.post('/fetch', async (req, res) => {
  const { url, cookie } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'url is required' });
  }

  // SSRF protection: only allow Instagram URLs.
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }
  if (!ALLOWED_HOSTS.has(parsedUrl.hostname.toLowerCase())) {
    return res.status(403).json({ error: `Blocked: only Instagram URLs are allowed (got ${parsedUrl.hostname})` });
  }
  if (parsedUrl.protocol !== 'https:') {
    return res.status(400).json({ error: 'Only HTTPS URLs are allowed' });
  }

  // Write the cookie to a temp Netscape-format file if provided.
  // yt-dlp reads cookies via --cookies <file>.
  let cookieFile = null;
  if (cookie && typeof cookie === 'string' && cookie.trim()) {
    cookieFile = path.join(os.tmpdir(), `ig-cookies-${crypto.randomUUID()}.txt`);
    let cookieText = cookie.trim();
    // Accept either a raw sessionid value or a full Netscape cookie file.
    if (!cookieText.startsWith('# Netscape')) {
      // Assume it's a sessionid value — wrap it in Netscape format.
      const sessionid = cookieText.replace(/^sessionid\s*=\s*/i, '');
      cookieText = [
        '# Netscape HTTP Cookie File',
        '# This is a generated file! Do not edit.',
        '',
        '.instagram.com\tTRUE\t/\tTRUE\t0\tsessionid\t' + sessionid,
      ].join('\n');
    }
    try {
      fs.writeFileSync(cookieFile, cookieText, { mode: 0o600 });
    } catch (e) {
      return res.status(500).json({ error: `Failed to write cookie file: ${e.message}` });
    }
  }

  // yt-dlp --dump-json returns a single JSON line with all metadata including
  // the direct video URL, thumbnail, duration, title, and description.
  const args = [
    '--dump-json',
    '--no-warnings',
    '--no-playlist',
    '--user-agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 320.0.4',
  ];
  if (cookieFile) args.push('--cookies', cookieFile);
  args.push(url);

  const result = await runYtDlp(args);

  // Clean up the temp cookie file.
  if (cookieFile) {
    try { fs.unlinkSync(cookieFile); } catch { /* best effort */ }
  }

  if (result.error) {
    return res.status(422).json({ error: `yt-dlp failed: ${result.error}`, details: result.stderr });
  }

  try {
    const info = JSON.parse(result.stdout);
    const video_url = info.url || (info.formats && info.formats[0]?.url) || null;
    const thumbnail_url = info.thumbnail || (info.thumbnails && info.thumbnails[0]?.url) || null;
    const caption = info.description || '';
    const title = info.title || '';
    const duration = typeof info.duration === 'number' ? info.duration : null;
    const author = info.uploader || info.channel || '';

    if (!video_url && !thumbnail_url) {
      return res.status(422).json({ error: 'No downloadable media found' });
    }

    return res.json({
      platform: 'instagram',
      source_url: url,
      video_url,
      thumbnail_url,
      caption,
      title,
      duration,
      author,
      slides: [],
    });
  } catch (e) {
    return res.status(500).json({ error: `Failed to parse yt-dlp output: ${e.message}`, raw: result.stdout?.slice(0, 500) });
  }
});

// Health check for Render.
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`IG Downloader service listening on port ${PORT}`);
});
