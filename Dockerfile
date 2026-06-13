# syntax=docker/dockerfile:1

ARG RUST_VERSION=1.93.0
ARG DEBIAN_VERSION=bookworm
# Local compose builds use these defaults. Production/trial releases must be
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
    ffmpeg \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 rend \
  && useradd --system --uid 10001 --gid rend --home-dir /nonexistent --shell /usr/sbin/nologin rend \
  && mkdir -p /var/lib/rend/edge-cache /var/spool/rend/edge-telemetry \
  && chown -R rend:rend /var/lib/rend /var/spool/rend

ENV RUST_LOG=info
ENV REND_FFMPEG_PATH=/usr/bin/ffmpeg
ENV REND_FFPROBE_PATH=/usr/bin/ffprobe
ENV REND_GIT_SHA=${REND_GIT_SHA}
ENV REND_BUILD_TIME=${REND_BUILD_TIME}
ENV REND_IMAGE_VERSION=${REND_IMAGE_VERSION}

WORKDIR /app
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

FROM runtime AS rend-media-worker
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
