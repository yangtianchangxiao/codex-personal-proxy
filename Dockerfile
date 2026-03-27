FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends dumb-init zstd \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY . .

RUN chmod +x scripts/docker-entrypoint.sh \
  && mkdir -p data logs

EXPOSE 3101

ENTRYPOINT ["dumb-init", "--", "./scripts/docker-entrypoint.sh"]
