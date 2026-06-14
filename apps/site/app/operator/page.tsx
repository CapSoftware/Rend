import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import {
  dashboardAccessFromHeaders,
} from "../../lib/dashboard-auth.ts";
import {
  canUseOperatorSurface,
  recentOperatorAuditRecords,
  type OperatorAction,
  type OperatorTargetType,
} from "../../lib/operator.ts";
import {
  latestPlaybackReadinessResult,
  type PlaybackReadinessArtifactTimings,
  type PlaybackReadinessEdgeResult,
  type PlaybackReadinessResult,
} from "../../lib/readiness.ts";

type OperatorPageProps = {
  searchParams: Promise<{
    status?: string | string[];
    message?: string | string[];
    purge?: string | string[];
  }>;
};

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Operator",
  robots: {
    index: false,
    follow: false,
  },
};

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function OperatorForm({
  action,
  label,
  targetType,
}: {
  action: OperatorAction;
  label: string;
  targetType: OperatorTargetType;
}) {
  return (
    <form action="/operator/action" className="app-key-form" method="post">
      <input name="action" type="hidden" value={action} />
      <input name="target_type" type="hidden" value={targetType} />
      <label htmlFor={`${targetType}-${action}-target`}>{targetType === "organization" ? "Organization ID" : "Asset ID"}</label>
      <input
        id={`${targetType}-${action}-target`}
        name="target_id"
        placeholder="00000000-0000-0000-0000-000000000000"
        required
        type="text"
      />
      <label htmlFor={`${targetType}-${action}-reason`}>Reason</label>
      <input
        id={`${targetType}-${action}-reason`}
        maxLength={1000}
        name="reason"
        required
        type="text"
      />
      <button className={action === "suspend" ? "app-danger" : undefined} type="submit">
        {label}
      </button>
    </form>
  );
}

function formatTimestamp(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? value
    : date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function formatMs(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "-";
  return `${Math.round(value)} ms`;
}

function formatCount(value: number | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "0";
  return new Intl.NumberFormat("en-US").format(value);
}

function statusClass(status: string | undefined) {
  return `app-pill app-state-${status || "missing"}`;
}

function metricValue(result: PlaybackReadinessResult, name: string) {
  for (const fixture of result.fixtures) {
    const metric = fixture.metrics?.find((entry) => entry.name === name);
    if (metric) return metric.value_ms;
  }
  return undefined;
}

function artifactTriplet(timings: PlaybackReadinessArtifactTimings | undefined) {
  return [
    formatMs(timings?.cold_miss?.ttfb_ms),
    formatMs(timings?.second_view_hit?.ttfb_ms),
    formatMs(timings?.warmed_hit?.ttfb_ms),
  ].join(" / ");
}

function allReadinessEdges(result: PlaybackReadinessResult): PlaybackReadinessEdgeResult[] {
  return result.fixtures.flatMap((fixture) => fixture.edges || []);
}

function ReadinessPanel({ result }: { result: Awaited<ReturnType<typeof latestPlaybackReadinessResult>> }) {
  if (!result.available) {
    return (
      <section className="app-panel">
        <div className="app-panel-title-row">
          <h2>Playback readiness</h2>
          <span className={statusClass("missing")}>missing</span>
        </div>
        <div className="app-empty">No readiness run has been recorded.</div>
      </section>
    );
  }

  const data = result.result;
  const edges = allReadinessEdges(data);
  const cache = data.cache_mix || {};
  const telemetry = data.telemetry_health || {};
  const cleanupStatus = data.cleanup?.status || "unknown";

  return (
    <section className="app-panel app-readiness-panel">
      <div className="app-panel-title-row">
        <div>
          <h2>Playback readiness</h2>
          <p className="app-muted app-mono">{data.run_id}</p>
        </div>
        <span className={statusClass(data.status)}>{data.status}</span>
      </div>

      <dl className="app-stats app-readiness-stats">
        <div>
          <dt>Completed</dt>
          <dd>{formatTimestamp(data.ended_at)}</dd>
        </div>
        <div>
          <dt>Target</dt>
          <dd>{data.target}</dd>
        </div>
        <div>
          <dt>Upload</dt>
          <dd>{formatMs(metricValue(data, "upload_response_ms"))}</dd>
        </div>
        <div>
          <dt>HLS ready</dt>
          <dd>{formatMs(metricValue(data, "upload_to_hls_ready_ms"))}</dd>
        </div>
        <div>
          <dt>Bootstrap</dt>
          <dd>{formatMs(metricValue(data, "playback_bootstrap_response_ms"))}</dd>
        </div>
        <div>
          <dt>Telemetry</dt>
          <dd>
            {formatCount(telemetry.request_count)} events, {formatCount(telemetry.edge_dropped_delta)} dropped
          </dd>
        </div>
        <div>
          <dt>Cache</dt>
          <dd>HIT {formatCount(cache.HIT)} / MISS {formatCount(cache.MISS)}</dd>
        </div>
        <div>
          <dt>Cleanup</dt>
          <dd>{cleanupStatus}</dd>
        </div>
      </dl>

      {edges.length === 0 ? (
        <div className="app-empty">No edge timings were recorded.</div>
      ) : (
        <div className="app-table-wrap app-readiness-table">
          <table className="app-table app-compact-table">
            <thead>
              <tr>
                <th>Edge</th>
                <th>Opener</th>
                <th>Manifest</th>
                <th>Segment</th>
                <th>Spool</th>
                <th>Bytes/min</th>
              </tr>
            </thead>
            <tbody>
              {edges.map((edge, index) => (
                <tr key={`${edge.edge_id}-${edge.region}-${index}`}>
                  <td>
                    <span className="app-mono">{edge.edge_id}</span>
                    <span className="app-muted"> {edge.region}</span>
                  </td>
                  <td>{artifactTriplet(edge.timings?.opener)}</td>
                  <td>{artifactTriplet(edge.timings?.manifest)}</td>
                  <td>{artifactTriplet(edge.timings?.segment)}</td>
                  <td>{formatCount(edge.telemetry?.spool_bytes_after)}</td>
                  <td>{formatCount(edge.bytes_per_delivered_minute_proxy?.bytes_per_delivered_minute)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default async function OperatorPage({ searchParams }: OperatorPageProps) {
  const access = await dashboardAccessFromHeaders(new Headers(await headers()));
  if (!access.ok) redirect(`/login?next=${encodeURIComponent("/operator")}`);
  if (!canUseOperatorSurface(access.context)) notFound();

  const [query, audits, readiness] = await Promise.all([
    searchParams,
    recentOperatorAuditRecords(),
    latestPlaybackReadinessResult(),
  ]);
  const status = firstParam(query.status);
  const message = firstParam(query.message);
  const purge = firstParam(query.purge);

  return (
    <div className="app-shell">
      <header className="app-topbar">
        <a href="/" aria-label="Rend home">
          <img src="/rend-logo.svg" alt="Rend" className="app-logo" />
        </a>
        <nav>
          <a href="/dashboard/assets">Assets</a>
          <a href="/dashboard/api-keys">API keys</a>
        </nav>
      </header>

      <main className="app-main">
        <section className="app-page-head">
          <div>
            <p className="app-kicker">Private</p>
            <h1>Operator controls</h1>
          </div>
        </section>

        {message ? (
          <section className={`app-callout app-callout-${status === "ok" ? "done" : "error"}`}>
            <span>{message}{purge === "1" ? " Purge attempted." : ""}</span>
          </section>
        ) : null}

        <ReadinessPanel result={readiness} />

        <section className="app-detail-grid">
          <div className="app-panel">
            <h2>Organizations</h2>
            <OperatorForm action="suspend" label="Suspend organization" targetType="organization" />
            <div className="app-form-spacer" />
            <OperatorForm action="restore" label="Restore organization" targetType="organization" />
          </div>

          <div className="app-panel">
            <h2>Assets</h2>
            <OperatorForm action="suspend" label="Suspend asset" targetType="asset" />
            <div className="app-form-spacer" />
            <OperatorForm action="restore" label="Restore asset" targetType="asset" />
          </div>
        </section>

        <section className="app-panel">
          <h2>Recent audit</h2>
          {audits.length === 0 ? (
            <div className="app-empty">No operator actions yet.</div>
          ) : (
            <div className="app-table-wrap">
              <table className="app-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Operator</th>
                    <th>Action</th>
                    <th>Target</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {audits.map((audit) => (
                    <tr key={audit.id}>
                      <td>{formatTimestamp(audit.created_at)}</td>
                      <td>{audit.operator_email}</td>
                      <td>{audit.action}</td>
                      <td className="app-mono">{audit.target_type}:{audit.target_id}</td>
                      <td>{audit.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
