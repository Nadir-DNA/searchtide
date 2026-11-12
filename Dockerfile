FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
# Navigateur intégré (connexion manuelle, publication par navigateur) : désactivé par défaut.
# Pour l'inclure : docker build --build-arg WITH_BROWSER=1 … (ou docker-compose.browser.yml). Voir docs/exploitation.md.
ARG WITH_BROWSER=0
WORKDIR /app
RUN if [ "$WITH_BROWSER" = "1" ]; then apk add --no-cache chromium font-noto; fi
ENV NODE_ENV=production DATABASE_PATH=/data/searchtide.db PORT=3030
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/web/dist ./web/dist
COPY package.json ./
COPY server ./server
# Exécution non root (utilisateur `node`, uid 1000) : le volume de données lui appartient.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3030
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3030/healthz || exit 1
CMD ["node", "--no-warnings", "server/index.ts"]
