# IG Downloader + Identity Models Service — yt-dlp + Node + Python on Render.
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
    libgl1 \
    libglib2.0-0 \
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
RUN pip install --no-cache-dir flask insightface==2.1 onnxruntime numpy pillow requests

# Pin and verify the FP32 weights at build time. get_model() does NOT
# automatically download a bare .onnx filename, and runtime downloads are
# too slow/unreliable for a 75-second face-swap request.
RUN mkdir -p /opt/models && \
    curl --fail --location --retry 3 --connect-timeout 20 --max-time 600 \
      -o /opt/models/inswapper_128.onnx \
      "https://huggingface.co/Aitrepreneur/insightface/resolve/fd887cdef0c73f32251198b8160d6771ac413fc0/inswapper_128.onnx" && \
    echo "e4a3f08c753cb72d04e10aa0f7dbe3deebbf39567d4ead6dce08e98aa49e16af  /opt/models/inswapper_128.onnx" | sha256sum -c -
# INSwapper.__init__ reparses the entire 554MB ONNX just to read this 1MB
# matrix. Extract it in the build, never duplicate the full graph at runtime.
RUN python -c "import onnx, numpy as np; m = onnx.load('/opt/models/inswapper_128.onnx'); np.save('/opt/models/inswapper_128.emap.npy', onnx.numpy_helper.to_array(m.graph.initializer[-1]))"
ENV INSWAPPER_MODEL_PATH=/opt/models/inswapper_128.onnx

# Face restoration (GFPGAN) to repair the 128px inswapper upscale without
# beautifying. CPU-only torch is installed FIRST from the CPU wheel index so
# gfpgan does not pull the ~2GB CUDA wheel. opencv-python needs libGL (above).
RUN pip install --no-cache-dir torch==2.3.1 torchvision==0.18.1 --index-url https://download.pytorch.org/whl/cpu
RUN pip install --no-cache-dir gfpgan scipy
# GFPGANv1.4 weights (348MB). Downloaded at build time so a swap never waits
# on a network fetch; the restorer is lazy-loaded only during a swap call.
RUN curl --fail --location --retry 3 --connect-timeout 20 --max-time 600 \
      -o /opt/models/GFPGANv1.4.pth \
      "https://github.com/TencentARC/GFPGAN/releases/download/v1.3.4/GFPGANv1.4.pth" && \
    test -s /opt/models/GFPGANv1.4.pth
ENV GFPGAN_WEIGHTS_PATH=/opt/models/GFPGANv1.4.pth
ENV RESTORER_WEIGHT=0.4

# Verify yt-dlp is on PATH.
RUN yt-dlp --version

WORKDIR /app

# Copy the service files.
COPY package.json ./
COPY server.js ./
COPY identity_models.py ./
COPY inswapper_runtime.py ./
COPY inswapper_loader.py ./
COPY restorer_runtime.py ./

RUN npm install --omit=dev

ENV NODE_ENV=production
ENV YTDLP_PATH=yt-dlp
ENV FLASK_PORT=5001

EXPOSE 3000

# Run both the Express server (port 3000) and the Flask identity models (port 5001).
# The Express server proxies /verify-arcface and /verify-adaface to the Flask app.
CMD ["sh", "-c", "python identity_models.py & node server.js"]