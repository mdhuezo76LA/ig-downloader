# IG Downloader Service

yt-dlp HTTP wrapper for age-restricted Instagram content. Deployed on Render, called by OLA Echo's Base44 backend functions as the age-restricted fallback.

## Step-by-step Render deployment

### 1. Push this folder to GitHub

These files are in the `render-service/` directory of your Base44 app's GitHub repo (2-way sync pushes them automatically). You can either:
- **Option A:** Deploy from the main repo, pointing Render at the `render-service/` subdirectory.
- **Option B:** Copy these 3 files (`server.js`, `package.json`, `Dockerfile`) into a new standalone repo.

Option A is simpler — everything stays in one place.

### 2. Create the service on Render

1. Go to **https://dashboard.render.com**
2. Click **New +** → **Web Service**
3. **Connect a repository** → select your OLA Echo GitHub repo
4. Configure:
   - **Name:** `ig-downloader`
   - **Region:** closest to you
   - **Branch:** `main` (or your default branch)
   - **Root Directory:** `render-service` ← important! This tells Render to use the Dockerfile in this folder.
   - **Runtime:** Docker (auto-detected from the Dockerfile)
   - **Instance Type:** Pro plan (you have this — gives you always-on + enough RAM)
5. Click **Advanced** and add these **Environment Variables:**

   | Key | Value | Notes |
   |-----|-------|-------|
   | `SHARED_SECRET` | (any random string — generate one) | **Write this down** — you'll paste the same value into Base44 as `IG_DOWNLOADER_SECRET` |
   | `PORT` | `3000` | Optional — Render sets this automatically, but explicit is safer |

6. Click **Create Web Service**

### 3. Wait for the build

Render will pull the Python image, install Node + ffmpeg + yt-dlp, and start the server. This takes ~3-5 minutes on first deploy. Watch the logs — you should see:

```
IG Downloader service listening on port 3000
```

### 4. Copy the service URL

Once deployed, Render gives you a URL like:
```
https://ig-downloader-xxxx.onrender.com
```
Copy this URL.

### 5. Set the secrets in Base44

In your Base44 app dashboard (Settings → Secrets / Environment Variables), add two secrets:

| Secret name | Value |
|-------------|-------|
| `IG_DOWNLOADER_URL` | `https://ig-downloader-xxxx.onrender.com` (your Render URL from step 4) |
| `IG_DOWNLOADER_SECRET` | The `SHARED_SECRET` value you set in step 2 |

The `IG_SESSION_COOKIE` secret already exists — the service reuses it.

### 6. Test it

In the OLA Echo app, paste an age-restricted Instagram reel URL into the ingest dialog. The flow is now:

1. **SMVD** (RapidAPI) — tries first, works for all public non-age-gated content
2. **Apify** (with session cookie) — tries second, works for some gated content
3. **Render yt-dlp service** (NEW) — tries third, handles age-gated content that Apify can't
4. **Manual upload** — final fallback if all three fail

### How it works

The Base44 backend function (`ingestSourceUrl` / `analyzeAsset`) calls:
```
POST https://ig-downloader-xxxx.onrender.com/fetch
Headers: { x-shared-secret: <IG_DOWNLOADER_SECRET> }
Body: { url: "https://www.instagram.com/reel/...", cookie: "<IG_SESSION_COOKIE>" }
```

The service writes the cookie to a temp Netscape-format file, runs `yt-dlp --dump-json --cookies <file> <url>`, and returns the direct video URL + thumbnail + metadata. Base44 then mirrors the media into its own storage (durable URLs that don't expire).

### Troubleshooting

- **Build fails:** Check that Root Directory is set to `render-service` (not the repo root).
- **401 Unauthorized:** The `SHARED_SECRET` in Render doesn't match `IG_DOWNLOADER_SECRET` in Base44.
- **yt-dlp fails on a URL:** yt-dlp's Instagram extractor breaks occasionally when IG changes their API. Run `yt-dlp -U` to update — on Render, redeploy the service (it reinstalls yt-dlp from PyPI on each deploy).
- **Timeout:** Age-gated content can take 30-60s. The service allows 90s. If it still times out, the cookie may be expired — update `IG_SESSION_COOKIE` in Base44.