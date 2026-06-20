// Client Live Chat — see every website chat conversation and take over from the
// AI in real time. Handles many conversations at once: pick one from the list to
// open it; "waiting" ones (a visitor asked for a human) are highlighted and ping.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { Loading, ErrorState, EmptyState } from '../../components/States';
import { formatDate } from '../../lib/format';

const LIST_POLL_MS = 4000;
const THREAD_POLL_MS = 3000;

const STATUS_LABEL = { ai: 'AI', waiting: 'Waiting', live: 'Live', closed: 'Closed' };
const STATUS_COLOR = {
  ai: '#64748b',
  waiting: '#b45309',
  live: '#047857',
  closed: '#94a3b8',
};

function StatusPill({ status }) {
  return (
    <span style={{
      fontSize: '.7rem', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '.04em',
      color: '#fff', background: STATUS_COLOR[status] || '#64748b',
      borderRadius: 999, padding: '2px 8px',
    }}>{STATUS_LABEL[status] || status}</span>
  );
}

export default function Chats() {
  const [chats, setChats] = useState(null);
  const [error, setError] = useState(null);
  const [activeId, setActiveId] = useState(null);
  const [thread, setThread] = useState(null);
  const [conv, setConv] = useState(null);
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const threadEnd = useRef(null);
  const prevWaiting = useRef(0);
  const notified = useRef(false);

  // -- conversation list polling --
  const loadList = useCallback(async () => {
    try {
      const d = await api.get('/admin/chats?status=active');
      setChats(d.chats || []);
      setError(null);
      // Ping when a new "waiting" conversation appears.
      const waiting = (d.chats || []).filter((c) => c.status === 'waiting').length;
      if (waiting > prevWaiting.current) pingNewWaiting();
      prevWaiting.current = waiting;
    } catch (e) {
      setError(e.message || 'Failed to load chats.');
    }
  }, []);

  useEffect(() => {
    loadList();
    const t = setInterval(loadList, LIST_POLL_MS);
    return () => clearInterval(t);
  }, [loadList]);

  // -- active thread polling --
  const loadThread = useCallback(async (id) => {
    if (!id) return;
    try {
      const d = await api.get(`/admin/chats/${id}/messages`);
      setThread(d.messages || []);
      setConv(d.conversation || null);
    } catch (e) {
      /* keep last thread on a transient poll error */
    }
  }, []);

  useEffect(() => {
    if (!activeId) return;
    loadThread(activeId);
    const t = setInterval(() => loadThread(activeId), THREAD_POLL_MS);
    return () => clearInterval(t);
  }, [activeId, loadThread]);

  useEffect(() => {
    if (threadEnd.current) threadEnd.current.scrollIntoView({ block: 'end' });
  }, [thread]);

  function pingNewWaiting() {
    try {
      // eslint-disable-next-line no-new
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880; g.gain.value = 0.05;
      o.start(); o.stop(ctx.currentTime + 0.18);
    } catch (e) { /* audio not allowed yet */ }
    try {
      if ('Notification' in window && Notification.permission === 'granted') {
        new Notification('A website visitor wants to chat', { body: 'Open Live Chat to take over.' });
      }
    } catch (e) {}
  }

  async function act(path, body) {
    if (!activeId) return;
    setBusy(true);
    try {
      await api.post(`/admin/chats/${activeId}/${path}`, body);
      await loadThread(activeId);
      await loadList();
    } catch (e) {
      setError(e.message || 'Action failed.');
    } finally {
      setBusy(false);
    }
  }

  async function sendReply() {
    const body = reply.trim();
    if (!body || busy) return;
    setReply('');
    setBusy(true);
    try {
      await api.post(`/admin/chats/${activeId}/message`, { body });
      await loadThread(activeId);
      await loadList();
    } catch (e) {
      setError(e.message || 'Could not send.');
      setReply(body);
    } finally {
      setBusy(false);
    }
  }

  function enableNotifications() {
    if ('Notification' in window && Notification.permission === 'default') {
      Notification.requestPermission();
    }
    notified.current = true;
  }

  if (chats === null && !error) return <Loading label="Loading chats…" />;
  if (error && chats === null) return <ErrorState message={error} onRetry={loadList} />;

  const waitingCount = (chats || []).filter((c) => c.status === 'waiting').length;

  return (
    <>
      <div className="page-head">
        <h1>Live Chat</h1>
        <p>
          Talk to visitors on your website in real time.{' '}
          {waitingCount > 0
            ? <strong style={{ color: STATUS_COLOR.waiting }}>{waitingCount} waiting for a human</strong>
            : 'The AI handles chats until you take over.'}
        </p>
      </div>

      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div style={{ display: 'flex', minHeight: 520, height: '70vh' }}>
          {/* conversation list */}
          <div style={{ width: 300, borderRight: '1px solid var(--border, #e4e9f0)', overflowY: 'auto', flexShrink: 0 }}>
            {(chats || []).length === 0 ? (
              <div style={{ padding: 20 }}>
                <EmptyState title="No conversations yet" message="When someone chats on your website, it shows up here." />
              </div>
            ) : (
              (chats || []).map((c) => (
                <button
                  key={c.id}
                  onClick={() => setActiveId(c.id)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
                    border: 'none', borderBottom: '1px solid var(--border, #eef2f6)',
                    background: c.id === activeId ? '#eef2ff' : (c.status === 'waiting' ? '#fffbeb' : '#fff'),
                    padding: '12px 14px',
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontWeight: 600, fontSize: '.9rem', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {c.visitor_name || 'Website visitor'}
                    </span>
                    <StatusPill status={c.status} />
                  </div>
                  <div style={{ fontSize: '.8rem', color: '#64748b', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.preview ? `${c.preview.role === 'visitor' ? '' : '↩ '}${c.preview.body}` : 'No messages yet'}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                    <span style={{ fontSize: '.7rem', color: '#9aa7b5' }}>{formatDate(c.last_message_at)}</span>
                    {c.unread && c.status !== 'closed' && <span style={{ width: 8, height: 8, borderRadius: 50, background: '#ef4444' }} />}
                  </div>
                </button>
              ))
            )}
          </div>

          {/* active thread */}
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            {!activeId ? (
              <div style={{ margin: 'auto', color: '#94a3b8', fontSize: '.95rem' }}>
                Select a conversation to view it.
              </div>
            ) : (
              <>
                <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border, #eef2f6)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700 }}>{conv?.visitor_name || 'Website visitor'}</div>
                    <div style={{ fontSize: '.78rem', color: '#64748b', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {conv?.visitor_contact ? conv.visitor_contact + ' · ' : ''}{conv?.source_url || ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
                    {conv && <StatusPill status={conv.status} />}
                    {conv && (conv.status === 'waiting' || conv.status === 'ai') && (
                      <button className="btn btn-primary" disabled={busy} onClick={() => act('claim')}>Take over</button>
                    )}
                    {conv && conv.status === 'live' && (
                      <button className="btn" disabled={busy} onClick={() => act('release')}>Hand back to AI</button>
                    )}
                    {conv && conv.status !== 'closed' && (
                      <button className="btn" disabled={busy} onClick={() => act('close')}>Close</button>
                    )}
                  </div>
                </div>

                <div style={{ flex: 1, overflowY: 'auto', padding: 16, background: '#f6f8fb' }}>
                  {(thread || []).map((m) => <Bubble key={m.id} m={m} />)}
                  <div ref={threadEnd} />
                </div>

                {conv && conv.status === 'closed' ? (
                  <div style={{ padding: 14, textAlign: 'center', color: '#94a3b8', fontSize: '.85rem', borderTop: '1px solid var(--border, #eef2f6)' }}>
                    This conversation is closed.
                  </div>
                ) : (
                  <div style={{ display: 'flex', gap: 8, padding: 12, borderTop: '1px solid var(--border, #eef2f6)' }}>
                    <input
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') sendReply(); }}
                      onFocus={() => { if (!notified.current) enableNotifications(); }}
                      placeholder={conv?.status === 'live' ? 'Type your reply…' : 'Type to take over the chat…'}
                      style={{ flex: 1, padding: '10px 12px', border: '1.5px solid var(--border, #e4e9f0)', borderRadius: 10, fontSize: '.95rem', outline: 'none' }}
                    />
                    <button className="btn btn-primary" disabled={busy || !reply.trim()} onClick={sendReply}>Send</button>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function Bubble({ m }) {
  if (m.role === 'system') {
    return <div style={{ textAlign: 'center', color: '#7a8699', fontSize: '.78rem', margin: '8px 0' }}>{m.body}</div>;
  }
  const isVisitor = m.role === 'visitor';
  const align = isVisitor ? 'flex-start' : 'flex-end';
  const bg = isVisitor ? '#fff' : (m.role === 'agent' ? '#4f46e5' : '#e7eaf0');
  const color = m.role === 'agent' ? '#fff' : '#1a2230';
  const label = isVisitor ? 'Visitor' : (m.role === 'agent' ? 'You' : 'AI');
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: align, marginBottom: 10 }}>
      <span style={{ fontSize: '.66rem', color: '#9aa7b5', margin: '0 4px 2px', textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</span>
      <div style={{
        maxWidth: '78%', padding: '9px 13px', borderRadius: 14, fontSize: '.92rem', lineHeight: 1.45,
        whiteSpace: 'pre-wrap', wordWrap: 'break-word', background: bg, color,
        border: isVisitor ? '1px solid #e4e9f0' : 'none',
        borderBottomLeftRadius: isVisitor ? 4 : 14, borderBottomRightRadius: isVisitor ? 14 : 4,
      }}>{m.body}</div>
    </div>
  );
}
