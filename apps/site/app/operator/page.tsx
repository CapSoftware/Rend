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

export default async function OperatorPage({ searchParams }: OperatorPageProps) {
  const access = await dashboardAccessFromHeaders(new Headers(await headers()));
  if (!access.ok) redirect(`/login?next=${encodeURIComponent("/operator")}`);
  if (!canUseOperatorSurface(access.context)) notFound();

  const [query, audits] = await Promise.all([searchParams, recentOperatorAuditRecords()]);
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
