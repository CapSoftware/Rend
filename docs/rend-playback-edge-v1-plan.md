# Rend Playback Edge V1 Plan

Draft: June 13, 2026

This is the simplified own-edge plan for Rend V1. It is intentionally separate
from `docs/rend-backend-infrastructure-plan.md`, which remains the long-term
cloud architecture.

This document is also an AI handoff artifact. A future agent should treat it as
a decision record and operating plan, not as a brainstorming prompt.

## Required Context Before Review

Before reviewing or changing this plan, read:

- `README.md` for the public product promise.
- `site/app/page.tsx` for the current landing page positioning.
- `docs/rend-backend-infrastructure-plan.md` for the long-term architecture.
- this document for the simplified V1 decision.

The important context is:

- The landing page promises one API call, one playback URL, fast startup,
  simple pricing, and open infrastructure.
- The long-term backend plan is directionally useful but too complex for the
  public V1 launch.
- A pure Bunny/Mux/Cloudflare wrapper is not differentiated enough.
- A full anycast/bare-metal network is too much for V1.
- The chosen wedge is a small Rend-owned edge that warms opener files in US East
  and London first, then adds regions by repeating the same node pattern.

## Fresh-Session Agent Protocol

If you are an AI agent reading this in a fresh session, follow this protocol
before changing anything:

1. Assume this plan is the current baseline.
2. Do not rewrite, reframe, or expand the plan just because a different design
   is also plausible.
3. First check whether the plan still satisfies the product goal:
   "one API call to upload, one Rend playback URL, and faster startup through
   Rend-owned regional edge caches."
4. If the plan is still coherent, say it is good and leave it unchanged.
5. Only propose changes when there is concrete evidence of a foot gun,
   implementation blocker, material cost issue, security issue, or measurable
   performance improvement.
6. When changing the plan, preserve the decision IDs and update the decision log
   instead of silently replacing the architecture.
7. A valid change must name:
   - the exact section being changed
   - the reason
   - the evidence or benchmark behind it
   - the impact on complexity, speed, cost, and launch timing
   - the smallest safe edit

Bad change:

> Replace GeoDNS with anycast because anycast is more elegant.

Good change:

> Replace provider X for London edge hosts because benchmark Y shows first-byte
> latency above target for three consecutive test days, and provider Z reduces
> p95 by 35% at similar cost. No API or cache contract changes required.

When asked to improve, review, or update this plan, return one of these verdicts
before editing:

- **No Change**: the plan is still good; explain why briefly.
- **Targeted Change**: one or more bounded edits are justified by evidence.
- **Reopen Decision**: a core assumption has failed and a decision ID needs to
  be revisited explicitly.

Most reviews should end in **No Change**. Stability is a feature.

## Why This Plan Exists

The original backend infrastructure plan is powerful but too complex for the
public V1 launch. It includes cloud control plane architecture, global edge
design, self-hosting boundaries, NATS, ClickHouse, Better Auth integration,
public benchmarks, billing-grade telemetry, abuse workflows, anycast, and
future bare-metal networking.

That is too much for the public V1 product.

At the same time, making Rend a thin wrapper around Bunny Stream, Cloudflare
Stream, or Mux would not be differentiated enough. Customers could bypass Rend,
and the product would not prove the landing page's speed thesis.

This plan chooses a middle path:

> Build a very small Rend-owned playback edge now, with two initial regions,
> while using boring durable infrastructure behind it.

The wedge is not "we own every layer." The wedge is:

> Rend pre-places the opening seconds of every video on Rend-owned regional edge
> nodes, so playback starts quickly from a cache Rend controls.

## Core Decision

Build **Rend Playback Edge** for V1.

Rend Playback Edge means:

- Rend controls the playback URLs.
- Rend runs regional playback cache nodes.
- Rend serves opener files and hot segments from local disk or memory.
- Rend validates signed playback URLs locally at the edge.
- Rend uses object storage as the durable origin.
- Rend uses an overflow CDN or direct origin fallback when needed.
- Rend can add new regions by provisioning another edge node and registering it.

Rend Playback Edge does not mean:

- anycast BGP
- owned bare metal everywhere
- custom QUIC/HTTP/3 work
- global distributed databases
- NATS JetStream
- broad ClickHouse-backed analytics beyond raw edge request telemetry
- JIT encoding at the edge
- per-segment authorization through the control plane
- full self-hosted product
- billing-grade global telemetry

Those can come later.

DEC-008 narrows this: V1 may use ClickHouse for raw edge playback request
telemetry only. That does not make V1 billing-grade, and it does not pull NATS,
watch beacons, public benchmarks, or dashboard analytics into the edge slice.

## Product Goal

V1 should let a developer:

1. Create an API key.
2. Upload a real video.
3. Receive a Rend playback URL immediately.
4. Embed a Rend player.
5. See the video become playable quickly.
6. Get fast startup because the opener and first segments are warmed to Rend's
   edge nodes.

The product should feel like:

```txt
POST a video.
Get one Rend playback URL.
Rend handles encoding, storage, delivery, player, and basic analytics.
```

## Public V1 Launch Position

Rend V1 is a public product target.

The implementation may still use controlled rollout mechanics while capacity,
costs, and abuse systems are validated, but the product plan should assume a
developer can sign up, create an API key, upload a video, embed playback, and
understand usage limits without manual support.

Do not build temporary rollout paths when a simple production path is available.
Usage limits, plan status, operator controls, readiness gates, and abuse
controls are product infrastructure, not launch scaffolding.

## Initial Regions

Launch with two edge regions:

- `us-east`
- `london`

Likely hostnames:

```txt
us-east.play.rend.so
london.play.rend.so
play.rend.so
```

`play.rend.so` should route to the nearest healthy edge by GeoDNS, latency DNS,
or a simple routing layer. Anycast is explicitly out of scope for V1.

Future regions should be easy to add:

- `la`
- `middle-east`
- other regions where customer traffic justifies it

Adding a region must not require changing customer API integrations.

## High-Level Architecture

```txt
Customer / SDK / dashboard
  -> api.rend.so
  -> control plane
     -> Postgres metadata
     -> object storage origin
     -> ffmpeg workers
     -> edge warmer

Viewer / player
  -> play.rend.so
  -> nearest healthy Rend edge
     -> local RAM/NVMe/disk cache
     -> origin fetch on cache miss
     -> overflow CDN/origin fallback when needed
```

## Core Components

### Control Plane

The control plane owns:

- organizations
- API keys
- video records
- upload state
- source object location
- generated artifact metadata
- playback URL creation
- signing keys
- edge registry
- warm requests
- basic analytics rollups

The control plane is not on the segment playback hot path.

### Object Storage Origin

Use Tigris as the default V1 object storage provider for durable source and
generated artifacts.

Reasons:

- Tigris is S3-compatible, so the storage interface can remain provider-neutral.
- Tigris has zero egress fees, which removes the largest origin cost risk for
  cache fills, opener warming, and overflow experiments.
- Tigris uses a global bucket model, which fits US East and London launch
  regions without managing cross-region replication in V1.

The origin is the source of truth. Edge disks are disposable caches.

Fallback-compatible providers:

- Cloudflare R2
- Backblaze B2
- Bunny Storage
- AWS S3 only when playback/cache-fill egress is shielded by CDN/private pricing
  or customer-specific pricing

Do not expose Tigris URLs, bucket names, or provider-specific URL shapes to
customers. Rend playback URLs remain the product interface.

### Encoding Workers

Use ffmpeg workers for V1.

Workers should generate:

```txt
/videos/{asset_id}/opener.mp4
/videos/{asset_id}/thumbnail.jpg
/videos/{asset_id}/master.m3u8
/videos/{asset_id}/{rendition}/segment_00000.ts
/videos/{asset_id}/{rendition}/segment_00001.ts
...
```

V1 should optimize for "playable quickly" over "all renditions perfect
immediately."

Recommended first behavior:

- If the source is already compatible H.264/AAC MP4, remux/faststart quickly.
- Run all ffmpeg/ffprobe/remux/encode work on customer media in a sandboxed
  child process or container with no database access, no object-storage
  credentials, constrained filesystem/network access, and CPU/memory/time
  limits. The parent worker brokers input and output.
- Generate an opener as early as practical.
- Generate a simple HLS ladder after that.
- Mark the playback URL available immediately, but report honest processing
  state to the player.

### Edge Nodes

Each edge node runs a small `rend-edge` service.

Responsibilities:

1. Validate signed playback URLs locally.
2. Serve opener files from RAM/disk when present.
3. Serve playlists and HLS segments from local disk when present.
4. On cache miss, fetch from origin, stream to the viewer, and write to cache.
5. Coalesce concurrent cache misses for the same object.
6. Evict old cache entries by size, age, and popularity.
7. Expose health and metrics.
8. Emit lightweight playback events asynchronously.

Non-responsibilities:

- user login
- organization management
- API key management
- billing decisions
- source-of-truth metadata
- synchronous Postgres queries during playback
- synchronous Redis queries during playback
- synchronous control-plane authorization per segment

## Edge Service API

Public playback:

```txt
GET /v/{asset_id}/opener.mp4
GET /v/{asset_id}/master.m3u8
GET /v/{asset_id}/{rendition}/{segment}
```

Internal operations:

```txt
GET  /healthz
GET  /readyz
GET  /metrics
POST /internal/warm
POST /internal/purge
POST /internal/reload-config
```

Only public playback paths are exposed through `play.rend.so`. `/metrics` and
`/internal/*` must bind to a private interface or private network path and must
require mTLS or signed control-plane requests. The default behavior for any
unknown or unauthenticated internal operation is deny.

The public URL shape may change, but the customer-facing contract should remain:

```txt
https://play.rend.so/{opaque_playback_id_or_token}
```

Avoid exposing storage provider URLs directly to customers.

## Speed Strategy

The V1 speed feature is opener warming.

At upload/encode completion, Rend should warm every active edge with:

- opener MP4
- thumbnail
- master playlist
- first 1-3 media segments

The opener should represent the first 3-8 seconds of video. It should be small
enough that warming it to every active edge is cheap.

Expected V1 behavior:

- The first frame can start from a regional Rend cache.
- The rest of the video can cold-fill from origin if needed.
- Hot videos become fast naturally as segments accumulate in edge cache.
- Cold videos still start quickly because the opener was pre-placed.

This is the narrow speed claim Rend should prove first.

## Routing

V1 routing should be deliberately simple:

```txt
play.rend.so
  -> GeoDNS / latency DNS / simple load balancer
  -> nearest healthy edge
```

Each region also has a direct hostname:

```txt
us-east.play.rend.so
london.play.rend.so
```

Direct hostnames make debugging, benchmarking, and customer support easier.

Anycast is not a V1 requirement. It should not be introduced until:

- at least three regions exist
- edge health automation is mature
- global traffic is large enough to justify operational risk
- the simple DNS model is measurably insufficient

## Region Add Flow

Adding a region should be a repeatable operational flow:

1. Provision a host with local NVMe or SSD.
2. Install or run the `rend-edge` container.
3. Set region config:

   ```txt
   EDGE_ID=la-001
   REGION=la
   CACHE_DIR=/var/lib/rend/cache
   CACHE_MAX_BYTES=...
   ORIGIN_ENDPOINT=...
   CONTROL_PLANE_URL=...
   SIGNING_KEY_SET_URL=...
   ```

4. Edge registers with the control plane.
5. Health checks pass.
6. DNS starts sending a small percentage of traffic.
7. Control plane warms recent/popular openers.
8. Region is promoted to normal routing.

The control plane should treat an edge node as disposable. If a node disappears,
traffic moves elsewhere and the cache is rebuilt.

## Self-Healing Behavior

"Self-healing" for V1 means the system can recover from ordinary node and cache
failures without manual data repair.

Required V1 self-healing:

- If an edge node fails health checks, stop routing traffic to it.
- If an edge cache file is missing, fetch it from origin.
- If a cache write fails, continue streaming from origin when possible.
- If warming fails, retry with backoff.
- If a region is added, automatically warm recent/popular openers.
- If a region is removed, playback continues through remaining regions or
  overflow.
- If the control plane is briefly unavailable, edges can keep serving already
  signed public playback URLs until token expiry.

Not required in V1:

- fully disconnected billing spools
- kill-switch propagation with strict SLAs
- cross-region consensus
- active-active control planes
- anycast route withdrawal

## Cache Policy

Use a two-tier local cache:

1. Memory metadata cache:
   - object existence
   - object size
   - content type
   - origin ETag/checksum
   - negative-cache misses briefly

2. Disk/NVMe object cache:
   - opener files
   - playlists
   - first segments
   - hot segments

Eviction priority:

1. Never evict currently streaming files.
2. Prefer keeping openers.
3. Prefer keeping first segments.
4. Prefer keeping recently requested hot segments.
5. Evict old deep-tail segments first.

Cache keys should be deterministic and derived from asset/artifact metadata, not
from raw user filenames.

## Playback Authorization

Use signed playback URLs or signed cookies/tokens.

V1 rules:

- Edge validates tokens locally.
- Token validation must not require a database call.
- Tokens include asset id, expiry, policy, and optional allowed host/path.
- Public videos can use long-ish asset-scoped signed URLs.
- Private/signed videos can come later or use shorter-lived tokens.

Ed25519 is still a good long-term choice, but V1 can use any well-supported
signature scheme if it is simple, local, and easy to rotate. Do not block V1 on
cryptographic elegance if the interface preserves future key rotation.

## Analytics

V1 analytics should be simple and useful, but the scopes are separate.

Edge request telemetry in V1:

- request count by asset
- region and edge id
- cache state for opener, manifest, and first segments
- `HIT`, `MISS`, and `COALESCED` cache counts
- bytes served
- response status and basic error code
- request latency

Player telemetry can come later:

- approximate watch minutes
- startup success/failure
- rebuffering
- viewer/session level analytics

Raw edge playback request telemetry is high-volume append/query data. Store it
in ClickHouse from V1 instead of putting raw playback events into Postgres.
Postgres remains the source of truth for asset metadata, jobs, lifecycle events,
delete state, API keys, and control-plane state.

Recommended V1 edge request telemetry flow:

```txt
edge playback request
  -> local async queue and bounded durable spool
  -> internal batch ingest on control plane
  -> ClickHouse raw playback_events table
  -> deduped bounded analytics queries and later rollups
```

Rules:

- Playback must never synchronously call the control plane, Postgres, Redis, or
  ClickHouse.
- Edge telemetry events carry an idempotent `event_id`.
- ClickHouse analytics queries must dedupe by `event_id`, because ClickHouse
  does not enforce uniqueness like Postgres.
- Do not store signed URL query strings, playback tokens, authorization
  headers, cookies, full request headers, full URLs, or client IPs in raw edge
  request telemetry.
- If the telemetry queue, spool, ingest API, or ClickHouse is unavailable,
  playback continues and telemetry may be dropped with counters/logs.
- This is not billing-grade accounting. Billing ledgers, watch beacons, NATS,
  public benchmark telemetry, and dashboard analytics remain separate later
  work.

## Pricing And Usage Guardrails

Rend Cloud launches with exactly two flat usage meters:

```txt
Delivery:
  $1 / 1,000 delivered minutes at every resolution

Storage:
  $3 / 1,000 stored minutes / month at every resolution

Minimum:
  none
```

Delivery is viewer watch time. Storage is video duration prorated for the time
the asset remains stored. Both are recorded precisely in seconds and presented
to customers in minutes, so individual events are never rounded up. Encoding is
included, and no resolution multiplier, pooled credit, bundle, or legacy plan is
part of the public model.

The rates mirror the Mux Basic public 1080p baseline while making the price the
same at every resolution. Rend competes on one API, one playback URL,
cold-start speed, open infrastructure, and a bill that can be calculated from
two minute counts.

Margin should be monitored using:

- average delivered bitrate
- traffic by region
- effective bandwidth cost by edge host and fallback provider
- cache hit rate
- origin egress and request volume
- storage footprint per stored minute
- encoder CPU cost per input minute

Tigris should be the default V1 origin because zero egress fees protect the
launch pricing model from cache-miss and warming surprises. If Tigris Range GET
latency, availability, or S3 compatibility fails the US East and London
benchmark path, switch behind the S3-compatible storage boundary instead of
changing customer URLs or edge behavior.

## Why Not Bunny As The Product

Using Bunny Stream directly for everything would be fast to launch, but weakly
differentiated.

Weak V1:

```txt
Rend API -> Bunny Stream API -> Bunny player/URLs
```

Problems:

- Customers can bypass Rend.
- Rend does not control playback behavior.
- Rend cannot prove its speed thesis.
- Rend cannot later swap the serving layer cleanly.
- The landing page's own-edge story becomes mostly marketing.

Acceptable V1:

```txt
Rend API
  -> Rend asset model
  -> Rend encoding/warming pipeline
  -> Rend playback URLs
  -> Rend edge cache nodes
  -> commodity object storage/origin behind the scenes
```

Bunny, R2, S3, or another provider may still be used as storage/CDN fallback.
They should be implementation details, not the customer-facing product.

## Why Not EBS As The Video Layer

Amazon EBS is not the right core primitive for Rend playback.

Use EBS for:

- boot disks
- Postgres volumes if running Postgres on EC2
- worker scratch space when convenient

Do not use EBS as:

- global origin storage
- edge cache strategy
- CDN replacement
- multi-region video storage

Reasons:

- EBS is attached to EC2 instances in the same Availability Zone.
- EBS is more expensive than common object storage for video libraries.
- EBS does not solve global delivery.
- EBS does not make adding LA or Middle East easy.
- Edge caches should be disposable local NVMe/SSD, not durable block volumes.

The right split:

```txt
Durable truth: object storage
Fast regional cache: local NVMe/SSD on edge nodes
Metadata truth: Postgres
```

## Hosting Guidance

Pick providers per region based on:

- network quality to local viewers
- local NVMe/SSD availability
- bandwidth pricing
- DDoS/network protection
- provisioning API quality
- operational simplicity

The first regions should optimize for learning, not perfect economics.

Initial deployment:

```txt
us-east:
  1 edge node
  1-2 TB local NVMe/SSD cache

london:
  1 edge node
  1-2 TB local NVMe/SSD cache

origin:
  S3-compatible object storage

overflow:
  direct origin or simple CDN fallback
```

Overflow and fallback must preserve the same customer-facing Rend URL and
playback authorization boundary. Do not redirect viewers to presigned object
storage URLs or provider-native URLs. A CDN fallback may serve playback only if
it validates Rend playback tokens or signed cookies at its edge with the same
key-rotation boundary as native `rend-edge`; otherwise fallback means
`rend-edge` streams from origin while preserving local token validation.

Next step after real traffic:

```txt
us-east:
  2 edge nodes

london:
  2 edge nodes

then:
  LA
  Middle East
```

Do not add regions before traffic or customer distribution justifies them,
unless the region is needed as a sales proof point.

## Implementation Phases

### Phase 1: Local Product Slice

Goal: upload a video and play it through a local edge process.

Build:

- video table
- upload endpoint
- object storage writes
- ffmpeg opener generation
- HLS generation
- local `rend-edge`
- signed playback URL
- basic player page

Pass condition:

- a real fixture video uploads
- opener is generated
- playback URL works through `rend-edge`
- cache miss fills from origin
- second request is served from local cache

### Phase 2: Two Real Edge Regions

Goal: US East and London serving real playback URLs.

Build:

- edge registration
- health checks
- GeoDNS or simple region routing
- warm endpoint
- purge endpoint
- edge metrics
- simple playback events

Pass condition:

- `us-east.play.rend.so` and `london.play.rend.so` both serve the same video
- opener is warmed to both
- origin fallback works
- unhealthy node is removed from routing

### Phase 3: Public V1 Launch

Goal: developers can sign up, upload, embed, monitor, and manage videos without
support.

Build:

- API keys
- dashboard list/detail page
- player embed
- delete video
- basic edge playback analytics
- public docs and generated SDK
- plan status, trial limits, and usage guardrails
- minimum chargeable plan through Stripe or manual invoicing
- abuse/suspend/delete operator action

Pass condition:

- developer can integrate without support
- cost per delivered minute is measured
- first-frame and startup metrics are visible internally
- public signup cannot create unbounded upload, storage, or delivery exposure

### Phase 4: Region Expansion

Goal: add LA or Middle East without architecture changes.

Build:

- region bootstrap script
- automatic opener warming for new region
- traffic ramp controls
- per-region cost/performance report

Pass condition:

- new region can be added from documented steps
- no customer API changes
- rollback is removing the region from routing

## Benchmark Targets

These are initial targets, not launch blockers unless the product feels bad.

Measure:

- upload-to-playback URL response time
- upload-to-opener-ready time
- upload-to-HLS-ready time
- edge opener cache hit rate
- opener TTFB by region
- player time to first frame
- cache miss latency
- second-view latency
- warm-region success rate
- origin fetch error rate

Initial desired behavior:

- warmed opener TTFB is consistently low in US East and London
- second request is materially faster than first request
- cold miss streams while caching
- common MP4 uploads become playable quickly

The exact numbers should be set after the first real implementation has a
baseline. Do not invent fake benchmark claims.

## Invariants

These should not change without strong evidence:

1. Customer-facing URLs are Rend URLs.
2. Object storage is the durable source of truth.
3. Edge cache is disposable.
4. The playback hot path does not require Postgres.
5. The playback hot path does not require the control plane for each segment.
6. V1 uses simple DNS/health routing, not anycast.
7. V1 starts with US East and London.
8. New regions are added by provisioning another edge node and registering it.
9. Opener warming is the first speed wedge.
10. Bunny/Cloudflare/AWS providers are replaceable infrastructure, not the
    product interface.

## Valid Reasons To Change The Plan

Change the plan only for one of these reasons:

- Security: current design exposes private videos, secrets, or customer data.
- Reliability: a component creates a clear single point of failure that blocks
  public V1 use.
- Cost: measured unit economics show negative or unsustainable margins.
- Performance: benchmarks show the speed wedge does not work.
- Simplicity: a smaller design achieves the same product goal with less code and
  no strategic loss.
- Customer evidence: early users need a different capability to pay or launch.
- Provider constraint: selected infrastructure cannot support a required flow.

Invalid reasons:

- preference for a different cloud provider without evidence
- adding anycast because it sounds more serious
- adding queues/analytics/databases before the simple flow works
- changing URL shapes for aesthetics
- replacing the edge design with a managed video platform wrapper
- expanding scope to live streaming
- optimizing for theoretical hyperscale before V1 traffic exists

## Review Checklist For Future Agents

When asked to review this plan, answer these first:

1. Does this still serve the landing page promise?
2. Does it keep Rend meaningfully different from Bunny/Mux/Cloudflare Stream?
3. Can US East and London be launched by a small team?
4. Can LA or Middle East be added without customer API changes?
5. Is the playback hot path free from control-plane/database dependency?
6. Is the durable/cache split still clean?
7. Are costs likely positive at proposed launch pricing?
8. Is any proposed change supported by evidence?

If the answer is yes, prefer "the plan is good" over churn.

## Open Questions

These should be answered with implementation data, not speculation:

- Whether Tigris meets the required Range GET latency, availability, and
  S3-compatibility behavior from US East and London edge nodes.
- Which host/provider gives the best edge bandwidth economics in each region?
- What opener duration gives the best startup/cost tradeoff: 3s, 5s, or 8s?
- Should V1 serve HLS only, or HLS plus progressive MP4 for simple embeds?
- What is the measured average bitrate of early customer traffic?
- What percentage of watch time comes from outside US East and London?
- How soon is LA justified by real traffic?
- Whether Middle East should be a Rend edge, an overflow region, or a customer
  specific deployment.

## Decision Log

### DEC-001: Build Rend Playback Edge Now

Decision: Build a simplified Rend-owned edge for V1 instead of using a managed
video platform as the full backend.

Reason: Owning playback URLs and regional opener cache is the clearest
differentiator that still fits a V1 scope.

### DEC-002: Start With US East And London

Decision: Launch two regions first.

Reason: They cover meaningful early traffic, provide a real multi-region proof,
and keep operational complexity manageable.

### DEC-003: Use Object Storage As Durable Origin

Decision: Store source and generated artifacts in Tigris by default, through an
S3-compatible storage boundary.

Reason: It keeps edge nodes disposable, makes new regions easy to bootstrap, and
removes retail origin egress as a V1 cost risk while preserving a clean provider
escape hatch.

### DEC-004: Use Local NVMe/SSD As Edge Cache

Decision: Edge nodes cache media on local disk, not EBS as the playback layer.

Reason: Edge cache should be fast, local, cheap, and disposable.

### DEC-005: Avoid Anycast In V1

Decision: Use GeoDNS, latency DNS, or simple regional routing.

Reason: Anycast adds operational risk before there is enough traffic or region
count to justify it.

### DEC-006: Preserve Long-Term Architecture Separately

Decision: Keep the detailed cloud infrastructure plan as the long-term target,
but do not force all of it into V1.

Reason: The long-term plan contains useful direction, but V1 needs a narrower
public launch scope.

### DEC-007: Use Two Flat Minute-Based Meters

Decision: Charge `$0.001` per delivered watch minute and `$0.003` per stored
minute per month, with the same rates at every resolution and no monthly
minimum.

Reason: These rates match the Mux Basic public 1080p baseline while giving Rend
a simpler model customers can calculate directly from two minute counts.

### DEC-008: Use ClickHouse For Raw Edge Request Telemetry In V1

Decision-log note: raw playback artifact request telemetry is high-volume
append/analytics data and should not live in Postgres.

Decision: Store raw edge playback request telemetry in ClickHouse from V1,
while keeping Postgres for metadata, jobs, lifecycle events, and control-plane
state.

Reason: Edge playback requests create high-volume append-only analytics data.
Putting those raw rows in Postgres would mix hot analytical telemetry with
transactional product state and would create a migration that is already
foreseeable. ClickHouse matches the raw event shape better, as long as the edge
ships asynchronously and analytics queries explicitly dedupe by `event_id`.

Evidence: The implemented local edge now serves every opener, manifest, and
segment request through `rend-edge`, including cache `HIT`, `MISS`, and
`COALESCED` states. That request stream is the natural source for delivery
analytics and can grow much faster than asset lifecycle events.

Impact:

- Complexity: adds one local dependency and ClickHouse schema/bootstrap work.
- Speed: preserves the playback hot path because telemetry is queued, spooled,
  and flushed asynchronously.
- Cost: avoids growing Postgres with raw per-request analytical data.
- Launch timing: acceptable because Phase 1 playback is already working and the
  telemetry scope is limited to edge request events.

Smallest safe edit: use ClickHouse only for raw edge playback request telemetry.
Do not add NATS, billing-grade usage ledgers, watch-time/player beacons, public
benchmark telemetry, dashboard charts, or cloud routing as part of this
decision.
