# syntax=docker/dockerfile:1
# Build context: monorepo root
# Base pinned to the alpine minor (was the floating `22-alpine`): node 22.x
# patch releases still flow, but a rebuild can't silently hop to a new alpine
# with different musl/apk behaviour.
FROM node:22-alpine3.24 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# patches/ before the install: the root postinstall (patch-package) applies
# them to node_modules (micromark's linear text resolver), and fails the
# build if one no longer applies. Only the patches for packages the backend
# installs: patch-package fails on a patch whose package is absent (astro's
# patch is frontend-only).
COPY patches/micromark+*.patch ./patches/
COPY packages/backend/package.json ./packages/backend/package.json
# Stub other workspace members so npm resolves the workspace graph
COPY packages/frontend/package.json ./packages/frontend/package.json
COPY packages/markdown/package.json ./packages/markdown/package.json
COPY packages/site/package.json ./packages/site/package.json
COPY packages/contract/package.json ./packages/contract/package.json
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace=packages/backend

FROM deps AS build
COPY packages/backend/tsconfig.json ./packages/backend/tsconfig.json
# tsconfig.build.json drops the test tree (which imports eslint-rules/, not
# copied here) so the production emit doesn't need it.
COPY packages/backend/tsconfig.build.json ./packages/backend/tsconfig.build.json
COPY packages/backend/src ./packages/backend/src
# @onden/markdown (the one Markdown pipeline): built to JS + declarations
# first — the backend's production emit reads its dist/index.d.ts, and node
# runs its dist/ (tsconfig.build.json).
COPY packages/markdown/tsconfig.json ./packages/markdown/tsconfig.json
COPY packages/markdown/src ./packages/markdown/src
RUN npm run build --workspace=packages/markdown
# @onden/site (website design: types, validation, CSS tools): same treatment,
# built after markdown (its declarations import @onden/markdown/block-id).
COPY packages/site/tsconfig.json packages/site/tsconfig.build.json ./packages/site/
COPY packages/site/src ./packages/site/src
RUN npm run build --workspace=packages/site
# @onden/contract (node shapes as zod schemas): same treatment; its declarations
# import @onden/markdown, so it is built after it too.
COPY packages/contract/tsconfig.json packages/contract/tsconfig.build.json ./packages/contract/
COPY packages/contract/src ./packages/contract/src
RUN npm run build --workspace=packages/contract
RUN npm run build --workspace=packages/backend

# MB8: runtime is DEBIAN slim, not alpine — the local embedder
# (@huggingface/transformers → onnxruntime-node) ships glibc-only native
# binaries; on musl it fails to load (verified: ld-linux missing, and gcompat
# still lacks __vsnprintf_chk). deps/build stages stay alpine (pure JS).
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
COPY package.json package-lock.json ./
# patches/ before the install (patch-package, as in the deps stage; backend
# packages only).
COPY patches/micromark+*.patch ./patches/
COPY packages/backend/package.json ./packages/backend/package.json
COPY packages/frontend/package.json ./packages/frontend/package.json
COPY packages/markdown/package.json ./packages/markdown/package.json
COPY packages/site/package.json ./packages/site/package.json
COPY packages/contract/package.json ./packages/contract/package.json
RUN --mount=type=cache,target=/root/.npm \
    npm ci --workspace=packages/backend --omit=dev
# MB8: local embeddings (EMBEDDING_MODE defaults to `local` outside tests).
# The package is deliberately NOT a declared dependency (it drags a native
# ONNX runtime through every lean install/CI), so the deployable image
# installs it explicitly — without it every embed outbox job dies and
# semantic search / suggestLinks serve stale vectors. --no-save keeps the
# lockfile untouched. Model weights (multilingual-e5-small) download on first
# use; compose mounts a named volume over the cache so rebuilds don't
# re-download.
RUN --mount=type=cache,target=/root/.npm \
    npm install --no-save --workspace=packages/backend @huggingface/transformers@3
COPY --from=build /app/packages/backend/dist ./packages/backend/dist
COPY --from=build /app/packages/markdown/dist ./packages/markdown/dist
COPY --from=build /app/packages/site/dist ./packages/site/dist
COPY --from=build /app/packages/contract/dist ./packages/contract/dist
COPY packages/backend/db ./packages/backend/db
RUN mkdir -p /app/packages/backend/content
WORKDIR /app/packages/backend
EXPOSE 8787
# The release version baked into the image (scripts/release.sh, release.yml
# pass ONDEN_BUILD_ID=v0.1.0; the frontend image gets the same value). Kept as
# its own variable because compose always sets ONDEN_BUILD_ID (empty when
# unset), and an empty env var would hide an ENV default. The CMD falls back to
# it only when ONDEN_BUILD_ID is empty, so a deploy that passes the git sha
# still wins. Declared last so a new version only invalidates this layer.
ARG ONDEN_BUILD_ID=
ENV ONDEN_IMAGE_BUILD_ID=$ONDEN_BUILD_ID
CMD ["sh", "-c", "export ONDEN_BUILD_ID=\"${ONDEN_BUILD_ID:-$ONDEN_IMAGE_BUILD_ID}\"; exec node dist/server.js"]
