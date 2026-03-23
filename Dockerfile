FROM oven/bun:1 AS base

# Install Python + gallery-dl + tesseract for TikTok scraping + OCR
RUN apt-get update && apt-get install -y \
    python3 \
    python3-pip \
    ffmpeg \
    tesseract-ocr \
    zip \
    --no-install-recommends \
    && pip3 install --break-system-packages gallery-dl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

# Copy source
COPY . .

# Create required directories
RUN mkdir -p uploads output tiktok-cache

EXPOSE 3456

CMD ["bun", "run", "server.ts"]
