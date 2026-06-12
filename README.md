<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/assets/rend-logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset=".github/assets/rend-logo-light.svg">
  <img alt="Rend" src=".github/assets/rend-logo-light.svg" width="220">
</picture>

### Video infrastructure, built for speed

One API call to upload. One URL that plays instantly, anywhere in the world.
And we're open source.

[**rend.so**](https://rend.so)

![Status](https://img.shields.io/badge/status-under_construction-E8590C)
![Server](https://img.shields.io/badge/server-AGPL--3.0-2F6FED)
![Player & SDKs](https://img.shields.io/badge/player_%26_SDKs-MIT-2F6FED)

</div>

---

> [!NOTE]
> Rend is under construction. Nothing below should be considered shipped until it is linked from [rend.so](https://rend.so). We're building it in public, right here.

## What is Rend?

Rend is the video platform for developers. POST a video, get back a playback URL. Upload, encoding, storage, delivery, signed playback, analytics, player and SDKs, one coherent surface instead of five services taped together.

Our thesis is simple: latency is round trips, not server time. So Rend deletes round trips, places bytes physically near viewers before they ask, and owns the network path from disk to viewer. The same code runs as a single self-hostable binary or as Rend Cloud on our anycast network.

## The infrastructure

One Rust service, two shapes. Everything below is the target for v1.

| Concern | Self-hosted node | Rend Cloud |
|---|---|---|
| State | SQLite, embedded | Postgres |
| Events | In-process | NATS JetStream |
| Analytics | DuckDB over Parquet | ClickHouse |
| Storage | Local disk or any S3 API | Object storage origin |
| Routing | One address | Anycast BGP |
| TLS | Built-in ACME | Built-in ACME |

The cloud runs on bare metal we own, not rented cloud compute. First bytes are served from RAM and NVMe at the edge, with HTTP/3, 0-RTT resumption, kTLS and BBR underneath. Every video gets a tiny instant-start clip replicated to every point of presence, so even the coldest video starts in one round trip. Renditions are encoded just in time, on the machine that will serve them, and encoding is included in the price.

And we measure it in public. The cloud doesn't launch without [rend.so/speed](https://rend.so), a live benchmark against named competitors, including the regions where we're not the fastest yet.

## v1

Video on demand, done excellently. Currently under construction:

- [ ] **Upload API**: POST a video, receive a playback URL. One call deep.
- [ ] **Instant start**: first frame in one round trip, even for cold assets
- [ ] **Just-in-time encoding**: x264 on the fast path, SVT-AV1 where it earns it
- [ ] **Drop-in player** with page-load prefetch
- [ ] **Signed playback**: Ed25519 tokens validated at the edge
- [ ] **Analytics**, queryable out of the box
- [ ] **SDKs and an MCP server**, generated from one OpenAPI spec
- [ ] **Self-hosting**: `docker run rend` gives you the complete product, free forever
- [ ] **Public benchmark** at rend.so/speed

No live streaming in v1, no DRM suite, and we are not a budget per-gigabyte CDN. Two meters only: delivery and storage, priced per minute, encoding included.

## In this repo

- [`site/`](./site) — the landing page at rend.so, Next.js and Tailwind v4

## License

The server will be AGPL-3.0. The player and SDKs will be MIT. If we disappeared tomorrow, Rend keeps running, self-hosted, forever.

---

<div align="center">

Built by [Cap Software](https://cap.so), the company behind Cap, the open source screen recorder.

**rend.so** · **rend.sh** · **rend.video**

</div>
