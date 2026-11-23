# syntax=docker/dockerfile:1
# Build context: monorepo root
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# patches/ before the install: the root postinstall (patch-package) applies
# them to node_modules (micromark's linear text resolver), and fails the
# build if one no longer applies. Astro is installed under packages/frontend,
# so its patch (CSS of lazy screens) is in packages/frontend/patches and is
# applied by that package's own postinstall, with the same failure rule.
COPY patches ./patches
COPY packages/frontend/package.json ./packages/frontend/package.json
COPY packages/frontend/patches ./packages/frontend/patches
COPY packages/backend/package.json ./packages/backend/package.json
COPY packages/markdown/package.json ./packages/markdown/package.json
COPY packages/site/package.json ./packages/site/package.json
COPY packages/contract/package.json ./packages/contract/package.json
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace=packages/frontend

FROM deps AS build
ARG PUBLIC_API_BASE_URL=/api
ENV PUBLIC_API_BASE_URL=$PUBLIC_API_BASE_URL
ARG ONDEN_BUILD_ID=
ENV ONDEN_BUILD_ID=$ONDEN_BUILD_ID
COPY packages/frontend/astro.config.mjs ./packages/frontend/astro.config.mjs
COPY packages/frontend/tsconfig.json   ./packages/frontend/tsconfig.json
COPY packages/frontend/src             ./packages/frontend/src
# The one Markdown pipeline (@onden/markdown), bundled from source (the
# frontend configs alias it to src/).
COPY packages/markdown/src             ./packages/markdown/src
# The website design package (@onden/site/react), bundled from source like markdown.
COPY packages/site/src                 ./packages/site/src
# 使用者看得到的更新說明（changes/README.md），build 時打包進前端。
COPY changes                           ./changes
COPY packages/frontend/public          ./packages/frontend/public
COPY packages/frontend/scripts         ./packages/frontend/scripts
RUN npm run build --workspace=packages/frontend

FROM node:22-alpine AS runtime
WORKDIR /app/packages/frontend
COPY --from=build /app/packages/frontend/dist ./dist
COPY --from=deps  /app/node_modules           /app/node_modules
COPY --from=deps  /app/packages/frontend/node_modules ./node_modules
ENV HOST=0.0.0.0
ENV PORT=80
EXPOSE 80
CMD ["node", "./dist/server/entry.mjs"]
