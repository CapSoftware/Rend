# syntax=docker/dockerfile:1

ARG RUST_VERSION=1.93.0
ARG DEBIAN_VERSION=bookworm
# Local compose builds use these defaults. Production releases must be
# built through scripts/release-images.sh, which overrides and validates them.
ARG REND_GIT_SHA=unknown
ARG REND_BUILD_TIME=unknown
ARG REND_IMAGE_VERSION=0.1.0
ARG REND_IMAGE_SOURCE=unknown

FROM rust:${RUST_VERSION}-slim-${DEBIAN_VERSION} AS builder

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    cmake \
    pkg-config \
  && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY services ./services
COPY migrations ./migrations

RUN cargo build --locked --release -p rend-api -p rend-edge

FROM debian:${DEBIAN_VERSION}-slim AS runtime
ARG REND_GIT_SHA=unknown
ARG REND_BUILD_TIME=unknown
ARG REND_IMAGE_VERSION=0.1.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 rend \
  && useradd --system --uid 10001 --gid rend --home-dir /nonexistent --shell /usr/sbin/nologin rend \
  && mkdir -p /var/lib/rend/edge-cache /var/spool/rend/edge-telemetry \
  && chown -R rend:rend /var/lib/rend /var/spool/rend

ENV RUST_LOG=info
ENV REND_GIT_SHA=${REND_GIT_SHA}
ENV REND_BUILD_TIME=${REND_BUILD_TIME}
ENV REND_IMAGE_VERSION=${REND_IMAGE_VERSION}

WORKDIR /app
USER rend

FROM runtime AS media-runtime
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*
ENV REND_FFMPEG_PATH=/usr/bin/ffmpeg
ENV REND_FFPROBE_PATH=/usr/bin/ffprobe
USER rend

FROM runtime AS rend-api
ARG REND_IMAGE_SOURCE=unknown
ARG REND_GIT_SHA=unknown
ARG REND_BUILD_TIME=unknown
ARG REND_IMAGE_VERSION=0.1.0
ENV REND_SERVICE_NAME=rend-api
LABEL org.opencontainers.image.source=${REND_IMAGE_SOURCE}
LABEL org.opencontainers.image.revision=${REND_GIT_SHA}
LABEL org.opencontainers.image.version=${REND_IMAGE_VERSION}
LABEL org.opencontainers.image.created=${REND_BUILD_TIME}
LABEL com.rend.service=rend-api
COPY --from=builder /app/target/release/rend-api /usr/local/bin/rend-api
ENTRYPOINT ["rend-api"]

FROM media-runtime AS rend-media-worker
ARG REND_IMAGE_SOURCE=unknown
ARG REND_GIT_SHA=unknown
ARG REND_BUILD_TIME=unknown
ARG REND_IMAGE_VERSION=0.1.0
ENV REND_SERVICE_NAME=rend-media-worker
LABEL org.opencontainers.image.source=${REND_IMAGE_SOURCE}
LABEL org.opencontainers.image.revision=${REND_GIT_SHA}
LABEL org.opencontainers.image.version=${REND_IMAGE_VERSION}
LABEL org.opencontainers.image.created=${REND_BUILD_TIME}
LABEL com.rend.service=rend-media-worker
COPY --from=builder /app/target/release/rend-api /usr/local/bin/rend-api
ENTRYPOINT ["rend-api", "worker", "media"]

FROM runtime AS rend-edge
ARG REND_IMAGE_SOURCE=unknown
ARG REND_GIT_SHA=unknown
ARG REND_BUILD_TIME=unknown
ARG REND_IMAGE_VERSION=0.1.0
ENV REND_SERVICE_NAME=rend-edge
LABEL org.opencontainers.image.source=${REND_IMAGE_SOURCE}
LABEL org.opencontainers.image.revision=${REND_GIT_SHA}
LABEL org.opencontainers.image.version=${REND_IMAGE_VERSION}
LABEL org.opencontainers.image.created=${REND_BUILD_TIME}
LABEL com.rend.service=rend-edge
COPY --from=builder /app/target/release/rend-edge /usr/local/bin/rend-edge
ENTRYPOINT ["rend-edge"]

FROM oven/bun:1.3.6-debian AS site-builder

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

COPY package.json bun.lock turbo.json ./
COPY apps ./apps
COPY packages ./packages
COPY scripts ./scripts
COPY docs/openapi ./docs/openapi

RUN bun install --frozen-lockfile \
  && cd apps/site \
  && DATABASE_URL=postgres://rend:rend@postgres:5432/rend \
  BETTER_AUTH_SECRET=rend-image-build-only-secret-not-for-runtime \
  BETTER_AUTH_URL=http://127.0.0.1:3000 \
  REND_ENV=production \
  REND_API_BASE_URL=http://rend-api:4000 \
  REND_PUBLIC_API_BASE_URL=http://127.0.0.1:4000 \
  REND_SITE_INTERNAL_TOKEN=rend-image-build-only-token \
  ./node_modules/.bin/next build

FROM oven/bun:1.3.6-debian AS rend-site

ARG REND_GIT_SHA=unknown
ARG REND_BUILD_TIME=unknown
ARG REND_IMAGE_VERSION=0.1.0
ARG REND_IMAGE_SOURCE=unknown

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV REND_SERVICE_NAME=rend-site
ENV REND_GIT_SHA=${REND_GIT_SHA}
ENV REND_BUILD_TIME=${REND_BUILD_TIME}
ENV REND_IMAGE_VERSION=${REND_IMAGE_VERSION}

LABEL org.opencontainers.image.source=${REND_IMAGE_SOURCE}
LABEL org.opencontainers.image.revision=${REND_GIT_SHA}
LABEL org.opencontainers.image.version=${REND_IMAGE_VERSION}
LABEL org.opencontainers.image.created=${REND_BUILD_TIME}
LABEL com.rend.service=rend-site

WORKDIR /app/apps/site
COPY --from=site-builder --chown=bun:bun /app /app

EXPOSE 3000
USER bun
ENTRYPOINT ["./node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "3000"]

FROM rend-site AS rend-site-standalone
