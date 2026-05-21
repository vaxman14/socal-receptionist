// Client Conversations — thread list on the left, transcript on the right.

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useFetch } from '../../lib/useFetch';
import { Loading, ErrorState, EmptyState } from '../../components/States';
import { Badge } from '../../components/Badge';
import { Transcript } from '../../components/Transcript';
import { formatDate } from '../../lib/format';

export default function Conversations() {
  const { data, loading, error, reload } = useFetch('/admin/conversations');
  const [selected, setSelected] = useState(null);
  const [messages, setMessages] = useState([]);
  const [msgLoading, setMsgLoading] = useState(false);
  const [msgError, setMsgError] = useState(null);

  const conversations = data?.conversations || [];

  useEffect(() => {
    if (!selected) {
      setMessages([]);
      return;
    }
    let active = true;
    setMsgLoading(true);
    setMsgError(null);
    api
      .get(`/admin/conversations/${selected.id}/messages`)
      .then((res) => {
        if (active) setMessages(res.messages || []);
      })
      .catch((err) => {
        if (active) setMsgError(err.message || 'Could not load this transcript.');
      })
      .finally(() => {
        if (active) setMsgLoading(false);
      });
    return () => {
      active = false;
    };
  }, [selected]);

  if (loading) return <Loading label="Loading conversations…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  return (
    <>
      <div className="page-head">
        <h1>Conversations</h1>
        <p>{conversations.length} text thread{conversations.length === 1 ? '' : 's'}.</p>
      </div>

      {conversations.length === 0 ? (
        <div className="card">
          <EmptyState
            title="No conversations yet"
            message="Customer text threads with your AI receptionist will show up here."
          />
        </div>
      ) : (
        <div className="split">
          <div className="card">
            <div className="card-head">
              <h2>Threads</h2>
            </div>
            <div className="thread-list">
              {conversations.map((c) => (
                <div
                  key={c.id}
                  className={`thread-item ${selected?.id === c.id ? 'active' : ''}`}
                  onClick={() => setSelected(c)}
                >
                  <div className="row-gap">
                    <span className="phone">{c.customer_phone}</span>
                    <span className="pull-right">
                      <Badge value={c.status} />
                    </span>
                  </div>
                  <div className="meta">
                    Last activity: {formatDate(c.last_message_at || c.created_at)}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <h2>{selected ? selected.customer_phone : 'Transcript'}</h2>
              {selected && <Badge value={selected.status} />}
            </div>
            {!selected ? (
              <div className="state">Select a conversation to read its transcript.</div>
            ) : msgLoading ? (
              <Loading label="Loading transcript…" />
            ) : msgError ? (
              <ErrorState message={msgError} />
            ) : (
              <Transcript messages={messages} />
            )}
          </div>
        </div>
      )}
    </>
  );
}
