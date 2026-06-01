// Owner Platform Overview — KPI cards from /admin/owner/stats.

import { Fragment } from 'react';
import { useFetch } from '../../lib/useFetch';
import { Loading, ErrorState } from '../../components/States';
import { titleCase } from '../../lib/format';

function Breakdown({ title, map }) {
  const entries = Object.entries(map || {});
  if (entries.length === 0) {
    return (
      <div className="card card-pad">
        <div className="section-title">{title}</div>
        <p className="muted">No data yet.</p>
      </div>
    );
  }
  return (
    <div className="card card-pad">
      <div className="section-title">{title}</div>
      <dl className="kv">
        {entries.map(([k, v]) => (
          <Fragment key={k}>
            <dt>{titleCase(k)}</dt>
            <dd>{v}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}

export default function PlatformOverview() {
  const { data, loading, error, reload } = useFetch('/admin/owner/stats');

  if (loading) return <Loading label="Loading platform stats…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  const s = data || {};

  return (
    <>
      <div className="page-head">
        <h1>Platform overview</h1>
        <p>Cross-tenant KPIs for SoCal Receptionist.</p>
      </div>

      <div className="grid grid-stats" style={{ marginBottom: 22 }}>
        <div className="stat">
          <div className="label">Tenants</div>
          <div className="value">{s.tenants?.total ?? 0}</div>
          <div className="sub">All businesses on the platform</div>
        </div>
        <div className="stat">
          <div className="label">Subscriptions</div>
          <div className="value">{s.subscriptions?.total ?? 0}</div>
          <div className="sub">{s.subscriptions?.active_or_trialing ?? 0} active or trialing</div>
        </div>
        <div className="stat">
          <div className="label">Leads</div>
          <div className="value">{s.leads_total ?? 0}</div>
          <div className="sub">Captured across all tenants</div>
        </div>
        <div className="stat">
          <div className="label">Messages</div>
          <div className="value">{s.messages_total ?? 0}</div>
          <div className="sub">Total messages handled</div>
        </div>
      </div>

      <div className="grid grid-2">
        <Breakdown title="Tenants by status" map={s.tenants?.by_status} />
        <Breakdown title="Subscriptions by plan" map={s.subscriptions?.by_plan} />
      </div>
    </>
  );
}
