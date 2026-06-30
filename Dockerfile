FROM node:20-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV CONFIG_PATH=/app/config.json
ENV PORT=3000

RUN apt-get update \
  && apt-get install -y --no-install-recommends awscli python3-pip \
  && rm -rf /var/lib/apt/lists/*

# Python deps for scripts/export_results.py (result downloads).
# Same requirements file is used for local execution outside the container.
COPY scripts/requirements.txt ./scripts/requirements.txt
RUN pip3 install --no-cache-dir --break-system-packages -r ./scripts/requirements.txt

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY config.example.json ./config.example.json

RUN mkdir -p /data/results

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "-c", "node src/server.js --config \"$CONFIG_PATH\" --port \"$PORT\""]
