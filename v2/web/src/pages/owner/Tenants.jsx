// Owner Tenants — every tenant with a subscription summary; row links to detail.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useFetch } from '../../lib/useFetch';
import { Loading, ErrorState, EmptyState, Pagination } from '../../components/States';
import { Badge } from '../../components/Badge';
import { formatDateShort } from '../../lib/format';

const LIMIT = 25;

export default function Tenants() {
  const [page, setPage] = useState(1);
  const { data, loading, error, reload } = useFetch(`/admin/owner/tenants?page=${page}&limit=${LIMIT}`);
  const navigate = useNavigate();

  if (loading) return <Loading label="Loading tenants…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  const tenants = data?.tenants || [];
  const total = data?.total ?? tenants.length;

  return (
    <>
      <div className="page-head">
        <h1>Tenants</h1>
        <p>{total} business{total === 1 ? '' : 'es'} on the platform.</p>
      </div>

      <div className="card">
        {total === 0 ? (
          <EmptyState title="No tenants yet" />
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Business</th>
                    <th>Slug</th>
                    <th>Status</th>
                    <th>Subscription</th>
                    <th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {tenants.map((t) => {
                    const sub = Array.isArray(t.subscriptions)
                      ? t.subscriptions[0]
                      : t.subscriptions;
                    return (
                      <tr
                        key={t.id}
                        className="clickable"
                        onClick={() => navigate(`/tenants/${t.id}`)}
                      >
                        <td style={{ fontWeight: 600 }}>{t.business_name}</td>
                        <td className="mono muted">{t.slug}</td>
                        <td>
                          <Badge value={t.status} />
                        </td>
                        <td>
                          {sub ? (
                            <span className="row-gap">
                              <Badge value={sub.status} />
                              {sub.plan && (
                                <span className="muted" style={{ fontSize: '0.82rem' }}>
                                  {sub.plan}
                                </span>
                              )}
                            </span>
                          ) : (
                            <span className="muted">None</span>
                          )}
                        </td>
                        <td className="muted">{formatDateShort(t.created_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination page={page} total={total} limit={LIMIT} onPage={setPage} />
          </>
        )}
      </div>
    </>
  );
}
