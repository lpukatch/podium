# syntax=docker/dockerfile:1

FROM node:24-bookworm-slim AS deps
WORKDIR /app
# better-sqlite3 is a native addon. When no prebuild matches this platform and
# node version it falls back to node-gyp, which needs python3 and a toolchain --
# absent from the slim image, and the reason the first CI docker build failed.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci


FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build


FROM node:24-bookworm-slim AS runtime
WORKDIR /app

# ffmpeg is the one heavy dependency and is non-negotiable: ffprobe is the whole
# product. tini reaps the ffprobe children -- without it a timed-out probe can
# leave a zombie holding a provider slot for the life of the container.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PODIUM_DATA_DIR=/app/data \
    PORT=3456 \
    # Next's standalone server binds to $HOSTNAME. Left unset it inherits the
    # container hostname -- in k8s, the pod name -- and the kubelet's probe
    # against the pod IP is refused. Bind everything instead.
    HOSTNAME=0.0.0.0

# Next's standalone output ships only the production dependency closure, which
# keeps the ffmpeg layer as the dominant cost rather than node_modules.
# Next's tracing already places better-sqlite3 -- prebuilt .node binaries and
# all -- inside standalone/node_modules, so there is nothing to hand-copy.
# Doing so previously also referenced `bindings`, which better-sqlite3 v13 no
# longer depends on, and the COPY failed outright.
COPY --from=build /app/.next/standalone ./
COPY --from=build /app/.next/static ./.next/static
COPY --from=build /app/public ./public
# The entrypoint, bundled to plain CJS by esbuild. Next's standalone output
# carries no tsx and an empty node_modules/.bin, so a TypeScript entrypoint
# cannot be run from this image -- it has to arrive pre-compiled.
#
# It lands at the app root, not in dist/, because it `require`s Next's own
# ./server.js and that path has to resolve.
COPY --from=build /app/dist/entry.cjs ./entry.cjs

RUN useradd --uid 1001 --create-home --shell /usr/sbin/nologin podium \
    && mkdir -p /app/data && chown -R podium:podium /app/data

USER podium
VOLUME ["/app/data"]
EXPOSE 3456

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "entry.cjs"]

HEALTHCHECK --interval=30s --timeout=10s --start-period=25s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:3456/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
