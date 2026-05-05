FROM node:22-bookworm-slim

# curl: healthcheck
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install dependencies first (layer caching)
COPY package.json ./
RUN npm install --production

# Copy application code and models
COPY src/ ./src/
COPY models/ ./models/

EXPOSE 8003

HEALTHCHECK --interval=10s --timeout=10s --retries=5 --start-period=120s \
    CMD curl -sf http://localhost:8003/health || exit 1

CMD ["node", "src/server.js"]
