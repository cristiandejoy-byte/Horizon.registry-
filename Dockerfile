# syntax=docker/dockerfile:1
#
# Imagen de produccion del Service Registry de Horizon.
# Sin dependencias nativas: la misma imagen funciona en linux/amd64 y
# linux/arm64 (Fargate con arquitectura ARM64).
#
# Build local:
#   docker build -t horizon-service-registry .
# Multi-arquitectura:
#   docker buildx build --platform linux/amd64,linux/arm64 -t <repo>:<tag> --push .

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:20-alpine AS runtime
ENV NODE_ENV=production \
    PORT=8761 \
    HOST=0.0.0.0
WORKDIR /app

# El usuario `node` ya existe en la imagen oficial.
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

USER node
EXPOSE 8761

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health" > /dev/null || exit 1

CMD ["node", "src/server.js"]
