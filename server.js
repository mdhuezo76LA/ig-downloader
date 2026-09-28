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

// Simple shared-secret auth. Accept either x-shared-secret (legacy) or
// X-Admin-Secret (used by the ensemble identity check) so both the IG
// Downloader endpoints and the proxied identity endpoints work with the
// same MIDDLEWARE_ADMIN_SECRET from Base44.
app.use((req, res, next) => {
  if (SHARED_SECRET) {
    const secret = req.headers['x-shared-secret'] || req.headers['x-admin-secret'];
    if (secret !== SHARED_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
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

// --- Overlay burn-in (ffmpeg) ---
// Burn a transparent overlay PNG onto a video. The PNG is pre-rendered
// client-side (pixel-perfect Google fonts) and uploaded to Base44 storage;
// this endpoint downloads both, scales the PNG to the video dimensions,
// overlays it, and streams the burned MP4 back. Used by the burnReelOverlay
// backend function so the reel export ships with the text overlay actually
// IN the video — the client-side canvas bake only produces a still cover.
const ALLOWED_BURN_HOSTS = (h) => {
  const x = (h || '').toLowerCase();
  return x.endsWith('base44.app') || x.endsWith('wixstatic.com') || x === 'media.base44.com';
};

function downloadToFile(url, dest) {
  return fetch(url).then((r) => {
    if (!r.ok) throw new Error(`download ${r.status}`);
    return r.arrayBuffer();
  }).then((ab) => fs.writeFileSync(dest, Buffer.from(ab)));
}

function probeDims(file) {
  return new Promise((resolve, reject) => {
    execFile('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], (err, stdout) => {
      if (err) return reject(err);
      const parts = (stdout || '').trim().split(',');
      resolve({ w: Number(parts[0]), h: Number(parts[1]) });
    });
  });
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    execFile('ffmpeg', args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).slice(-800)));
      resolve();
    });
  });
}

app.post('/burn-overlay', async (req, res) => {
  const { video_url, overlay_png_url } = req.body || {};
  if (!video_url || !overlay_png_url) return res.status(400).json({ error: 'video_url and overlay_png_url are required' });
  let vUrl, pUrl;
  try { vUrl = new URL(video_url); pUrl = new URL(overlay_png_url); }
  catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (!ALLOWED_BURN_HOSTS(vUrl.hostname) || !ALLOWED_BURN_HOSTS(pUrl.hostname)) {
    return res.status(403).json({ error: 'Blocked: only Base44/Wix storage URLs allowed' });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burn-'));
  const videoFile = path.join(dir, 'in.mp4');
  const pngFile = path.join(dir, 'overlay.png');
  const outFile = path.join(dir, 'out.mp4');
  try {
    await downloadToFile(video_url, videoFile);
    await downloadToFile(overlay_png_url, pngFile);
    const { w, h } = await probeDims(videoFile);
    if (!w || !h) throw new Error('Could not probe video dimensions');
    await runFfmpeg([
      '-y', '-i', videoFile, '-i', pngFile,
      '-filter_complex', `[1]scale=${w}:${h}[png];[0][png]overlay=0:0`,
      '-c:a', 'copy', '-movflags', '+faststart',
      outFile,
    ]);
    const buf = fs.readFileSync(outFile);
    res.setHeader('Content-Type', 'video/mp4');
    return res.send(buf);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'burn-overlay failed' });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// --- Text overlay burn-in via ffmpeg drawtext (no PNG needed) ---
// Burn text directly onto a video using ffmpeg's drawtext filter. Takes a
// video_url + overlay_spec (text, font, color, position, size, box, shadow)
// and returns the burned MP4. Used by the auto-bake step in
// completeReelRenders so overlays are burned at render completion without
// any client-side PNG generation. Font files are downloaded at build time
// (see Dockerfile); falls back to DejaVu Sans Bold if a Google Font is
// missing.
const FONT_MAP = {
  inter_bold: '/usr/share/fonts/google/Inter-Bold.ttf',
  anton: '/usr/share/fonts/google/Anton-Regular.ttf',
  bebas_neue: '/usr/share/fonts/google/BebasNeue-Regular.ttf',
  oswald_bold: '/usr/share/fonts/google/Oswald-Bold.ttf',
  playfair_bold: '/usr/share/fonts/google/PlayfairDisplay-Bold.ttf',
};
const DEJAVU_MAP = {
  inter_bold: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  anton: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  bebas_neue: '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  oswald_bold: '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  playfair_bold: '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf',
};

function resolveFont(fontFamily) {
  const gf = FONT_MAP[fontFamily] || FONT_MAP.inter_bold;
  if (fs.existsSync(gf)) return gf;
  const dj = DEJAVU_MAP[fontFamily] || DEJAVU_MAP.inter_bold;
  return fs.existsSync(dj) ? dj : '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
}

function mapTextPosition(position, margin) {
  const m = margin;
  const map = {
    'top-left': { x: `${m}`, y: `${m}` },
    'top-center': { x: '(w-text_w)/2', y: `${m}` },
    'top-right': { x: `w-text_w-${m}`, y: `${m}` },
    'center-left': { x: `${m}`, y: '(h-text_h)/2' },
    'center': { x: '(w-text_w)/2', y: '(h-text_h)/2' },
    'center-right': { x: `w-text_w-${m}`, y: '(h-text_h)/2' },
    'bottom-left': { x: `${m}`, y: `h-text_h-${m}` },
    'bottom-center': { x: '(w-text_w)/2', y: `h-text_h-${m}` },
    'bottom-right': { x: `w-text_w-${m}`, y: `h-text_h-${m}` },
  };
  return map[position] || map['bottom-center'];
}

app.post('/burn-text', async (req, res) => {
  const { video_url, overlay_spec } = req.body || {};
  if (!video_url || !overlay_spec || !overlay_spec.text || !String(overlay_spec.text).trim()) {
    return res.status(400).json({ error: 'video_url and overlay_spec.text are required' });
  }
  let vUrl;
  try { vUrl = new URL(video_url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (!ALLOWED_BURN_HOSTS(vUrl.hostname)) {
    return res.status(403).json({ error: 'Blocked: only Base44/Wix storage URLs allowed' });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'burntext-'));
  const videoFile = path.join(dir, 'in.mp4');
  const outFile = path.join(dir, 'out.mp4');
  const textFile = path.join(dir, 'text.txt');
  try {
    await downloadToFile(video_url, videoFile);
    const { w, h } = await probeDims(videoFile);
    if (!w || !h) throw new Error('Could not probe video dimensions');

    // Write text to a file to avoid ffmpeg drawtext escaping issues.
    fs.writeFileSync(textFile, String(overlay_spec.text));

    const fontFile = resolveFont(overlay_spec.font_family);
    const fontSize = Math.max(12, Math.round(h * (overlay_spec.font_size_pct || 6) / 100));
    const margin = Math.max(8, Math.round(h * 0.03));
    const pos = mapTextPosition(overlay_spec.position, margin);

    // Build the drawtext filter options.
    const parts = [
      `fontfile=${fontFile}`,
      `textfile=${textFile}`,
      `fontcolor=${overlay_spec.color_hex || '#FFFFFF'}`,
      `fontsize=${fontSize}`,
      `x=${pos.x}`,
      `y=${pos.y}`,
      'line_spacing=4',
    ];
    if (overlay_spec.has_box) {
      parts.push('box=1');
      const boxAlpha = overlay_spec.box_opacity ?? 0.5;
      parts.push(`boxcolor=${overlay_spec.box_color_hex || '#000000'}@${boxAlpha}`);
      parts.push('boxborderw=10');
    }
    if (overlay_spec.has_shadow) {
      parts.push(`shadowcolor=${overlay_spec.shadow_color_hex || '#000000'}`);
      parts.push('shadowx=2');
      parts.push('shadowy=2');
    }
    // Optional duration limit: show text only for the first N seconds.
    if (overlay_spec.duration && Number(overlay_spec.duration) > 0) {
      parts.push(`enable='lt(t,${Number(overlay_spec.duration)})'`);
    }
    const drawtext = `drawtext=${parts.join(':')}`;

    await runFfmpeg([
      '-y', '-i', videoFile,
      '-vf', drawtext,
      '-c:a', 'copy',
      '-movflags', '+faststart',
      outFile,
    ]);
    const buf = fs.readFileSync(outFile);
    res.setHeader('Content-Type', 'video/mp4');
    return res.send(buf);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'burn-text failed' });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// --- Video trim for Kling Motion Control (ffmpeg) ---
// Kling MC rejects source videos > 30s. This endpoint trims a Base44-hosted
// MP4 to the first N seconds (max 30) using ffmpeg stream copy (-c copy -t),
// then streams the trimmed MP4 back. Called by dispatchReelProduce when a
// reel's source video exceeds Kling's 30s limit.
app.post('/trim', async (req, res) => {
  const { video_url, max_duration } = req.body || {};
  if (!video_url) return res.status(400).json({ error: 'video_url is required' });
  let vUrl;
  try { vUrl = new URL(video_url); }
  catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (!ALLOWED_BURN_HOSTS(vUrl.hostname)) {
    return res.status(403).json({ error: 'Blocked: only Base44/Wix storage URLs allowed' });
  }
  const maxDur = Math.min(Math.max(Number(max_duration) || 30, 1), 30);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trim-'));
  const inFile = path.join(dir, 'in.mp4');
  const outFile = path.join(dir, 'out.mp4');
  try {
    await downloadToFile(video_url, inFile);
    // -t trims to the first N seconds; -c copy avoids re-encoding (fast, lossless).
    await runFfmpeg([
      '-y', '-i', inFile,
      '-t', String(maxDur),
      '-c', 'copy',
      '-movflags', '+faststart',
      outFile,
    ]);
    const buf = fs.readFileSync(outFile);
    res.setHeader('Content-Type', 'video/mp4');
    return res.send(buf);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'trim failed' });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// --- Video normalization (ffmpeg) ---
// Re-encode a video with clean metadata so downstream tools (the
// tensorart-middleware sanitizer) don't crash on ffprobe returning 'N/A'
// for duration/bitrate/etc. A fast libx264 ultrafast pass guarantees every
// metadata field is properly written. Used by the sanitizeReel function's
// auto-retry path when the middleware reports "probe failed: could not
// convert string to float: 'N/A'".
app.post('/normalize', async (req, res) => {
  const { video_url } = req.body || {};
  if (!video_url) return res.status(400).json({ error: 'video_url is required' });
  let vUrl;
  try { vUrl = new URL(video_url); }
  catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (!ALLOWED_BURN_HOSTS(vUrl.hostname)) {
    return res.status(403).json({ error: 'Blocked: only Base44/Wix storage URLs allowed' });
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'norm-'));
  const inFile = path.join(dir, 'in.mp4');
  const outFile = path.join(dir, 'out.mp4');
  try {
    await downloadToFile(video_url, inFile);
    await runFfmpeg([
      '-y', '-i', inFile,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      '-fflags', '+genpts',
      outFile,
    ]);
    const buf = fs.readFileSync(outFile);
    res.setHeader('Content-Type', 'video/mp4');
    return res.send(buf);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'normalize failed' });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// --- Video stitching (ffmpeg concat filter) ---
// Concatenate multiple video clips into a single MP4. Used by the Create
// Test Lane to stitch 3 short Kling clips into a ~15s reel. Re-encodes with
// the concat filter for codec compatibility (clips may have slightly
// different encoding parameters from Kling).
app.post('/stitch', async (req, res) => {
  const { video_urls } = req.body || {};
  if (!Array.isArray(video_urls) || video_urls.length < 2) {
    return res.status(400).json({ error: 'video_urls array (2+ items) required' });
  }
  for (const u of video_urls) {
    let parsed;
    try { parsed = new URL(u); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
    if (!ALLOWED_BURN_HOSTS(parsed.hostname)) {
      return res.status(403).json({ error: 'Blocked: only Base44/Wix storage URLs allowed' });
    }
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stitch-'));
  try {
    const files = await Promise.all(video_urls.map(async (url, i) => {
      const f = path.join(dir, `clip-${i}.mp4`);
      await downloadToFile(url, f);
      return f;
    }));
    const outFile = path.join(dir, 'out.mp4');
    const filterComplex = files.map((_, i) => `[${i}:v:0]`).join('') +
      `concat=n=${files.length}:v=1:a=0[outv]`;
    await runFfmpeg([
      '-y', ...files.flatMap(f => ['-i', f]),
      '-filter_complex', filterComplex,
      '-map', '[outv]',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
      '-movflags', '+faststart',
      outFile,
    ]);
    const buf = fs.readFileSync(outFile);
    res.setHeader('Content-Type', 'video/mp4');
    return res.send(buf);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'stitch failed' });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// --- Extract a single frame from a video (ffmpeg) ---
// Extracts a frame at a specific timestamp. Used by the Create Test Lane
// to run identity gates on the final stitched cut.
app.post('/extract-frame', async (req, res) => {
  const { video_url, timestamp } = req.body || {};
  if (!video_url) return res.status(400).json({ error: 'video_url required' });
  let vUrl;
  try { vUrl = new URL(video_url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
  if (!ALLOWED_BURN_HOSTS(vUrl.hostname)) {
    return res.status(403).json({ error: 'Blocked: only Base44/Wix storage URLs allowed' });
  }
  const ts = Number(timestamp) || 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-'));
  const inFile = path.join(dir, 'in.mp4');
  const outFile = path.join(dir, 'frame.jpg');
  try {
    await downloadToFile(video_url, inFile);
    await runFfmpeg([
      '-y', '-ss', String(ts), '-i', inFile,
      '-vframes', '1', '-q:v', '2',
      outFile,
    ]);
    const buf = fs.readFileSync(outFile);
    res.setHeader('Content-Type', 'image/jpeg');
    return res.send(buf);
  } catch (e) {
    return res.status(500).json({ error: e.message || 'extract-frame failed' });
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

// --- Identity model proxy ---
// Proxy /verify-arcface and /verify-adaface to the Flask identity models
// app running on port 5001 (started alongside this Express server by the
// Dockerfile CMD). The Flask app (identity_models.py) handles the actual
// InsightFace/AdaFace inference; this just forwards the request so the
// ensemble check can hit a single URL for both the IG Downloader and the
// identity endpoints.
const FLASK_PORT = process.env.FLASK_PORT || 5001;

async function proxyToFlask(req, res, path) {
  try {
    const r = await fetch(`http://localhost:${FLASK_PORT}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Secret': req.headers['x-admin-secret'] || '' },
      body: JSON.stringify(req.body || {}),
    });
    const text = await r.text();
    try {
      const data = JSON.parse(text);
      return res.status(r.status).json(data);
    } catch {
      // Flask returned non-JSON (HTML error page). Include diagnostic info:
      // the Flask HTTP status, content-type, and a sanitized snippet of
      // the response body (last 800 chars — where the Python traceback is).
      // Strip any line that might contain secrets (admin-secret headers).
      const rawSnippet = text.slice(-800)
        .split('\n')
        .filter(line => !/admin.?secret|shared.?secret|x-admin/i.test(line))
        .join('\n');
      return res.status(r.status).json({
        error: 'Flask returned non-JSON',
        flask_status: r.status,
        flask_content_type: r.headers.get('content-type'),
        flask_body_snippet: rawSnippet,
      });
    }
  } catch (e) {
    return res.status(502).json({ error: `Identity model service unavailable: ${e.message}` });
  }
}

app.post('/verify-arcface', (req, res) => proxyToFlask(req, res, '/verify-arcface'));
app.post('/verify-adaface', (req, res) => proxyToFlask(req, res, '/verify-adaface'));
app.post('/verify-identity', (req, res) => proxyToFlask(req, res, '/verify-identity'));

// Health check for Render.
app.get('/health', (req, res) => res.json({ status: 'ok', models: 'arcface,adaface,proxy' }));

app.listen(PORT, () => {
  console.log(`IG Downloader service listening on port ${PORT}`);
});
