# IG Downloader Service — yt-dlp + Node on Render.
# Base: Python image (yt-dlp is Python). Node is installed on top.

FROM python:3.12-slim

# Install Node.js 20 (for the Express server).
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    gnupg \
    ffmpeg \
  && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# Install yt-dlp (latest stable).
RUN pip install --no-cache-dir -U yt-dlp

# Verify yt-dlp is on PATH.
RUN yt-dlp --version

WORKDIR /app

# Copy the service files.
COPY package.json ./
COPY server.js ./

RUN npm install --omit=dev

ENV NODE_ENV=production
ENV YTDLP_PATH=yt-dlp

EXPOSE 3000

CMD ["node", "server.js"]