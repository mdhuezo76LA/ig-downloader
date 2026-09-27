# IG Downloader + Identity Models Service â€” yt-dlp + Node + Python on Render.
# Base: Python image (yt-dlp is Python, identity models need Python).
# Node is installed on top for the Express server.

FROM python:3.12-slim

# Install Node.js 20 (for the Express server) + ffmpeg + fonts.
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    gnupg \
    ffmpeg \
    fonts-dejavu \
    fontconfig \
  && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/*

# Download Google Fonts for the /burn-text ffmpeg drawtext endpoint.
RUN mkdir -p /usr/share/fonts/google && \
    curl -fsSL -o /usr/share/fonts/google/Inter-Bold.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/inter/static/Inter_24pt-Bold.ttf" || true && \
    curl -fsSL -o /usr/share/fonts/google/Anton-Regular.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/anton/Anton-Regular.ttf" || true && \
    curl -fsSL -o /usr/share/fonts/google/BebasNeue-Regular.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/bebasneue/BebasNeue-Regular.ttf" || true && \
    curl -fsSL -o /usr/share/fonts/google/Oswald-Bold.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/oswald/static/Oswald-Bold.ttf" || true && \
    curl -fsSL -o /usr/share/fonts/google/PlayfairDisplay-Bold.ttf "https://raw.githubusercontent.com/google/fonts/main/ofl/playfairdisplay/static/PlayfairDisplay-Bold.ttf" || true && \
    fc-cache -f

# Install yt-dlp (latest stable).
RUN pip install --no-cache-dir -U yt-dlp

# Install Python dependencies for identity models (InsightFace + ONNX Runtime, no PyTorch).
RUN pip install --no-cache-dir flask insightface onnxruntime numpy pillow requests

# Verify yt-dlp is on PATH.
RUN yt-dlp --version

WORKDIR /app

# Copy the service files.
COPY package.json ./
COPY server.js ./
COPY identity_models.py ./

RUN npm install --omit=dev

ENV NODE_ENV=production
ENV YTDLP_PATH=yt-dlp
ENV FLASK_PORT=5001

EXPOSE 3000

# Run both the Express server (port 3000) and the Flask identity models (port 5001).
# The Express server proxies /verify-arcface and /verify-adaface to the Flask app.
CMD ["sh", "-c", "python identity_models.py & node server.js"]
