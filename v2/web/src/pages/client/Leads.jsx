// Client Leads — full table of captured leads.

import { useFetch } from '../../lib/useFetch';
import { Loading, ErrorState, EmptyState } from '../../components/States';
import { Badge } from '../../components/Badge';
import { formatDate } from '../../lib/format';

export default function Leads() {
  const { data, loading, error, reload } = useFetch('/admin/leads');

  if (loading) return <Loading label="Loading leads…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  const leads = data?.leads || [];

  return (
    <>
      <div className="page-head">
        <h1>Leads</h1>
        <p>{leads.length} lead{leads.length === 1 ? '' : 's'} captured by your receptionist.</p>
      </div>

      <div className="card">
        {leads.length === 0 ? (
          <EmptyState
            title="No leads yet"
            message="When the AI receptionist qualifies a customer, they'll appear here."
          />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Customer</th>
                  <th>Phone</th>
                  <th>Service interest</th>
                  <th>Status</th>
                  <th>Notes</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {leads.map((l) => (
                  <tr key={l.id}>
                    <td>{l.customer_name || <span className="muted">Unknown</span>}</td>
                    <td className="mono">{l.customer_phone}</td>
                    <td>{l.service_interest || '—'}</td>
                    <td>
                      <Badge value={l.status} />
                    </td>
                    <td style={{ maxWidth: 280 }}>{l.notes || '—'}</td>
                    <td className="muted">{formatDate(l.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
