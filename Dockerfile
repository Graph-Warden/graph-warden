# One image for the API and the gwarden CLI. Build: docker build -t graph-warden .
# API: the default command. CLI: docker run graph-warden gwarden <command>.
FROM node:24-slim AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile --ignore-scripts \
 && pnpm -r build \
 && pnpm --filter @graph-warden/api deploy --prod --legacy /out/api \
 && pnpm --filter @graph-warden/cli deploy --prod --legacy /out/cli

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out/api ./api
COPY --from=build /out/cli ./cli
RUN printf '#!/bin/sh\nexec node /app/cli/dist/main.js "$@"\n' > /usr/local/bin/gwarden && chmod +x /usr/local/bin/gwarden
USER node
EXPOSE 8080
CMD ["node", "/app/api/dist/main.js"]
