# L'étape de construction tourne sur la plateforme de la machine qui construit : elle ne produit que du
# JavaScript, sans module natif, que l'image finale (amd64 ou arm64) reprend tel quel.
FROM --platform=$BUILDPLATFORM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
LABEL org.opencontainers.image.source="https://github.com/sylis/gmail-drive-stat" \
      org.opencontainers.image.description="WinDirStat pour Google : diagnostic et nettoyage de l'espace Gmail et Drive" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    PORT=8080 \
    DATABASE_PATH=/data/gmailstat.sqlite
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" || exit 1
CMD ["node", "dist/server/main.js"]
