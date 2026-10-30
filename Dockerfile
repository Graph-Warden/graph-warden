# One image for the API and the gwarden CLI. Build: docker build -t graph-warden .
# API: the default command. CLI: docker run graph-warden gwarden <command>.
FROM node:24-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile --ignore-scripts \
 && pnpm build \
 && pnpm --filter @graph-warden/api deploy --prod --legacy /out/api \
 && pnpm --filter @graph-warden/cli deploy --prod --legacy /out/cli \
 && pnpm --filter @graph-warden/worker deploy --prod --legacy /out/worker

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/api ./api
COPY --from=build /out/cli ./cli
# The ingestion worker: docker run graph-warden gwarden-worker. It runs git on its clones.
COPY --from=build /out/worker ./worker
# The web app, served by the API when GWARDEN_WEB_SECRET is set.
COPY --from=build /src/packages/web/dist ./web
ENV GWARDEN_WEB_DIR=/app/web
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/* \
 && printf '#!/bin/sh\nexec node /app/cli/dist/main.js "$@"\n' > /usr/local/bin/gwarden && chmod +x /usr/local/bin/gwarden \
 && printf '#!/bin/sh\nexec node /app/worker/dist/main.js "$@"\n' > /usr/local/bin/gwarden-worker && chmod +x /usr/local/bin/gwarden-worker
USER node
EXPOSE 8080
CMD ["node", "/app/api/dist/main.js"]
