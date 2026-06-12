// Client Calls — table of inbound calls with outcome badges, audio + transcript.

import { Fragment, useState } from 'react';
import { useFetch } from '../../lib/useFetch';
import { Loading, ErrorState, EmptyState, Pagination } from '../../components/States';
import { Badge } from '../../components/Badge';
import { formatDate, formatDuration } from '../../lib/format';

const LIMIT = 25;

export default function Calls() {
  const [page, setPage] = useState(1);
  const { data, loading, error, reload } = useFetch(`/admin/calls?page=${page}&limit=${LIMIT}`);
  const [expanded, setExpanded] = useState(null);

  if (loading) return <Loading label="Loading calls…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  const calls = data?.calls || [];
  const total = data?.total ?? calls.length;

  return (
    <>
      <div className="page-head">
        <h1>Calls</h1>
        <p>{total} inbound call{total === 1 ? '' : 's'} to your receptionist.</p>
      </div>

      <div className="card">
        {total === 0 ? (
          <EmptyState
            title="No calls yet"
            message="Inbound phone calls handled by your AI receptionist will appear here."
          />
        ) : (
          <>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>From</th>
                    <th>To</th>
                    <th>Outcome</th>
                    <th>Duration</th>
                    <th>When</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {calls.map((c) => {
                    const hasDetail = c.recording_url || c.transcript;
                    const isOpen = expanded === c.id;
                    return (
                      <Fragment key={c.id}>
                        <tr
                          className={hasDetail ? 'clickable' : ''}
                          onClick={() => hasDetail && setExpanded(isOpen ? null : c.id)}
                        >
                          <td className="mono">{c.from_number}</td>
                          <td className="mono">{c.to_number}</td>
                          <td>
                            <Badge value={c.outcome} />
                          </td>
                          <td>{formatDuration(c.duration_seconds)}</td>
                          <td className="muted">{formatDate(c.created_at)}</td>
                          <td className="muted">
                            {hasDetail ? (isOpen ? 'Hide' : 'Details') : ''}
                          </td>
                        </tr>
                        {isOpen && hasDetail && (
                          <tr>
                            <td colSpan={6} style={{ background: 'var(--light)' }}>
                              {c.recording_url && (
                                <div style={{ marginBottom: c.transcript ? 12 : 0 }}>
                                  <div className="section-title">Recording</div>
                                  <audio controls src={c.recording_url}>
                                    Your browser does not support audio playback.
                                  </audio>
                                </div>
                              )}
                              {c.transcript && (
                                <div>
                                  <div className="section-title">Transcript</div>
                                  <div style={{ whiteSpace: 'pre-wrap', fontSize: '0.88rem' }}>
                                    {c.transcript}
                                  </div>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination page={page} total={total} limit={LIMIT} onPage={(p) => { setPage(p); setExpanded(null); }} />
          </>
        )}
      </div>
    </>
  );
}
