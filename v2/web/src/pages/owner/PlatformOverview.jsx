// Owner Platform Overview — KPI cards from /admin/owner/stats.

import { Fragment } from 'react';
import { useFetch } from '../../lib/useFetch';
import { Loading, ErrorState } from '../../components/States';
import { titleCase } from '../../lib/format';

const STATUS_LABEL = {
  sms_pending_compliance: 'Active',
};

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

  // Merge sms_pending_compliance into active for display
  const merged = {};
  for (const [k, v] of entries) {
    const label = STATUS_LABEL[k] || titleCase(k);
    merged[label] = (merged[label] || 0) + v;
  }

  return (
    <div className="card card-pad">
      <div className="section-title">{title}</div>
      <dl className="kv">
        {Object.entries(merged).map(([label, v]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
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
          <div className="label">Calls handled</div>
          <div className="value">{s.calls_total ?? s.messages_total ?? 0}</div>
          <div className="sub">Total calls across all tenants</div>
        </div>
      </div>

      <div className="grid grid-2">
        <Breakdown title="Tenants by status" map={s.tenants?.by_status} />
        <Breakdown title="Subscriptions by plan" map={s.subscriptions?.by_plan} />
      </div>
    </>
  );
}
