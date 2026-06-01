// Client Overview — status banner, headline counts, recent leads + calls.

import { Link } from 'react-router-dom';
import { useFetch } from '../../lib/useFetch';
import { Loading, ErrorState } from '../../components/States';
import { StatusBanner } from '../../components/StatusBanner';
import { Badge } from '../../components/Badge';
import { formatDate } from '../../lib/format';

export default function Overview() {
  const me = useFetch('/admin/me');
  const leads = useFetch('/admin/leads');
  const calls = useFetch('/admin/calls');

  if (me.loading) return <Loading label="Loading your dashboard…" />;
  if (me.error) return <ErrorState message={me.error} onRetry={me.reload} />;

  const tenant = me.data?.tenant || {};
  const leadList = leads.data?.leads || [];
  const callList = calls.data?.calls || [];

  return (
    <>
      <div className="page-head">
        <h1>{tenant.business_name || 'Overview'}</h1>
        <p>Your AI receptionist at a glance.</p>
      </div>

      <StatusBanner status={tenant.status} />

      <div className="grid grid-stats" style={{ marginBottom: 24 }}>
        <div className="stat">
          <div className="label">Leads</div>
          <div className="value">{leads.loading ? '—' : leadList.length}</div>
          <div className="sub">Captured by the receptionist</div>
        </div>
        <div className="stat">
          <div className="label">Calls</div>
          <div className="value">{calls.loading ? '—' : callList.length}</div>
          <div className="sub">Inbound phone calls</div>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <div className="card-head">
            <h2>Recent leads</h2>
            <Link className="btn btn-ghost btn-sm" to="/leads">
              View all
            </Link>
          </div>
          {leads.loading ? (
            <Loading />
          ) : leads.error ? (
            <ErrorState message={leads.error} onRetry={leads.reload} />
          ) : leadList.length === 0 ? (
            <div className="state">No leads yet.</div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Customer</th>
                    <th>Interest</th>
                    <th>Status</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {leadList.slice(0, 5).map((l) => (
                    <tr key={l.id}>
                      <td>{l.customer_name || l.customer_phone}</td>
                      <td>{l.service_interest || '—'}</td>
                      <td>
                        <Badge value={l.status} />
                      </td>
                      <td className="muted">{formatDate(l.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Recent calls</h2>
            <Link className="btn btn-ghost btn-sm" to="/calls">
              View all
            </Link>
          </div>
          {calls.loading ? (
            <Loading />
          ) : calls.error ? (
            <ErrorState message={calls.error} onRetry={calls.reload} />
          ) : callList.length === 0 ? (
            <div className="state">No calls yet.</div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>From</th>
                    <th>Outcome</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {callList.slice(0, 5).map((c) => (
                    <tr key={c.id}>
                      <td className="mono">{c.from_number}</td>
                      <td>
                        <Badge value={c.outcome} />
                      </td>
                      <td className="muted">{formatDate(c.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
