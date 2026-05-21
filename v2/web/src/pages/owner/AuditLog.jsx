// Owner Audit Log — platform-wide audit trail.
// GET /admin/owner/audit-log  ->  { audit_log: [...] }

import { useFetch } from '../../lib/useFetch';
import { Loading, ErrorState, EmptyState } from '../../components/States';
import { formatDate, titleCase } from '../../lib/format';

function renderMeta(meta) {
  if (!meta || typeof meta !== 'object' || Object.keys(meta).length === 0) {
    return <span className="muted">—</span>;
  }
  return (
    <span className="mono" style={{ fontSize: '0.78rem' }}>
      {JSON.stringify(meta)}
    </span>
  );
}

export default function AuditLog() {
  const { data, loading, error, reload } = useFetch('/admin/owner/audit-log');

  if (loading) return <Loading label="Loading audit log…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  const entries = data?.audit_log || [];

  return (
    <>
      <div className="page-head">
        <h1>Audit log</h1>
        <p>{entries.length} most recent platform event{entries.length === 1 ? '' : 's'}.</p>
      </div>

      <div className="card">
        {entries.length === 0 ? (
          <EmptyState
            title="No audit entries yet"
            message="Owner and system actions across the platform will be recorded here."
          />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Actor</th>
                  <th>Action</th>
                  <th>Target</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="muted" style={{ whiteSpace: 'nowrap' }}>
                      {formatDate(e.created_at)}
                    </td>
                    <td>{titleCase(e.actor_type)}</td>
                    <td className="mono">{e.action}</td>
                    <td>
                      {e.target_type ? (
                        <>
                          <div>{titleCase(e.target_type)}</div>
                          {e.target_id && <div className="mono muted">{e.target_id}</div>}
                        </>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>{renderMeta(e.metadata)}</td>
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
