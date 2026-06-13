<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/rend-logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset=".github/assets/rend-logo-light.svg">
  <img alt="Rend" src=".github/assets/rend-logo-light.svg" width="220">
</picture>

### Video infrastructure, built for speed

One API call to upload. One Rend playback URL. First bytes warmed on
Rend's bare-metal edge. And we're open source.

[**Rend.so**](https://rend.so)

![Status](https://img.shields.io/badge/status-under_construction-E8590C)
![Server](https://img.shields.io/badge/server-AGPL--3.0-2F6FED)
![Player & SDKs](https://img.shields.io/badge/player_%26_SDKs-MIT-2F6FED)

</div>

---

> [!NOTE]
> Rend is being built in public. Features become official as they are linked from [Rend.so](https://rend.so).

## What is Rend?

Rend is the video platform for developers. POST a video, get back a playback URL. Upload, encoding, storage, delivery, signed playback, analytics, player and SDKs, one coherent surface instead of five services taped together.

Our thesis is simple: latency is round trips, not server time. So Rend deletes round trips, places bytes physically near viewers before they ask, and owns the playback path from cache to viewer.

## The infrastructure

Rend Cloud serves video through bare-metal playback edge nodes backed by durable
storage. Rend controls the playback URL and pre-places the opening seconds of
each video on edge-local RAM and NVMe/SSD.

Cloud shape:

| Concern | Rend Cloud v1 |
|---|---|
| API and state | Rust control plane with Postgres metadata |
| Uploads | One-call upload path |
| Origin | S3-compatible object storage, Tigris by default |
| Encoding | ffmpeg workers generate opener, thumbnail, and HLS playback |
| Edge | Bare-metal `rend-edge` nodes in US East and London with local RAM/NVMe/SSD cache |
| Routing | Rend playback URLs routed by GeoDNS, latency DNS, or regional routing |
| Authorization | Signed playback URLs or tokens validated locally at the edge |
| Analytics | Playback analytics for views, watch time, startup, region, and cache state |
| Resilience | Origin or CDN backup path without exposing provider URLs |

## v1

Video on demand, built around fast startup:

- [ ] **Upload API**: POST a video, receive a playback URL. One call deep.
- [ ] **Fast opener path**: generate a playable opener early in the upload pipeline
- [ ] **Rend edge playback**: warm openers and first segments to US East and London
- [ ] **Origin-backed cache**: stream cache misses from durable object storage
- [ ] **HLS playback**: opener first, adaptive renditions after that
- [ ] **Drop-in player** with page-load prefetch
- [ ] **Signed playback**: tokens validated locally at the edge
- [ ] **Playback analytics**: views, watch minutes, startup success, region, cache state
- [ ] **SDKs and an MCP server**, generated from one OpenAPI spec
- [ ] **Measured speed**: baseline upload-to-playable and first-frame metrics

Rend Cloud v1 is video on demand. Pricing uses two minute-based meters:
delivery and storage. Encoding is included. 4K starts in supported regions or
approved accounts while delivery economics are measured.

## In this repo

- [`site/`](./site) — the landing page at Rend.so, Next.js and Tailwind v4

## License

The server will be AGPL-3.0. The player and SDKs will be MIT.

---

<div align="center">

Built by [Cap Software](https://cap.so), the company behind Cap, the open source screen recorder.

**Rend.so** · **Rend.sh** · **Rend.video**

</div>
