// Floating support chat widget — bottom-right corner of the app.
// Talks to /api/support-chat/* on the backend (Groq AI + email transcript).

import { useState, useEffect, useRef } from 'react';

const API_BASE = import.meta.env.VITE_API_BASE || '';

function genSessionId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

const INITIAL_MESSAGE = {
  role: 'assistant',
  content: "Hey! 👋 I'm the SoCal Receptionist support bot. Ask me anything — pricing, how the service works, account help, whatever you need.",
};

export default function ChatWidget() {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState([INITIAL_MESSAGE]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [sessionId] = useState(genSessionId);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (open) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
      inputRef.current?.focus();
    }
  }, [open, history]);

  // Send transcript when the widget is closed after a real conversation
  function handleClose() {
    setOpen(false);
    if (history.length > 1) {
      fetch(`${API_BASE}/api/support-chat/end`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, history }),
      }).catch(() => {});
    }
  }

  async function send() {
    const msg = input.trim();
    if (!msg || loading) return;
    setInput('');

    const userMsg = { role: 'user', content: msg };
    const nextHistory = [...history, userMsg];
    setHistory(nextHistory);
    setLoading(true);

    try {
      const res = await fetch(`${API_BASE}/api/support-chat/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          message: msg,
          history: nextHistory.slice(0, -1).filter(m => m.role !== 'assistant' || m !== INITIAL_MESSAGE),
        }),
      });
      const data = await res.json();
      setHistory(h => [...h, { role: 'assistant', content: data.reply }]);
    } catch {
      setHistory(h => [...h, { role: 'assistant', content: 'Sorry, something went wrong. Try emailing support@socalreceptionist.com.' }]);
    } finally {
      setLoading(false);
    }
  }

  function onKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <>
      {/* Chat panel */}
      {open && (
        <div style={styles.panel}>
          {/* Header */}
          <div style={styles.header}>
            <div style={styles.headerLeft}>
              <div style={styles.avatar}>SR</div>
              <div>
                <div style={styles.headerTitle}>SoCal Support</div>
                <div style={styles.headerSub}>Typically replies instantly</div>
              </div>
            </div>
            <button style={styles.closeBtn} onClick={handleClose} aria-label="Close chat">✕</button>
          </div>

          {/* Messages */}
          <div style={styles.messages}>
            {history.map((m, i) => (
              <div key={i} style={m.role === 'user' ? styles.userBubbleWrap : styles.botBubbleWrap}>
                <div style={m.role === 'user' ? styles.userBubble : styles.botBubble}>
                  {m.content}
                </div>
              </div>
            ))}
            {loading && (
              <div style={styles.botBubbleWrap}>
                <div style={{ ...styles.botBubble, color: '#999' }}>…</div>
              </div>
            )}
            <div ref={bottomRef} />
          </div>

          {/* Input */}
          <div style={styles.inputRow}>
            <textarea
              ref={inputRef}
              style={styles.textarea}
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={onKey}
              placeholder="Type a message…"
              rows={1}
            />
            <button
              style={{ ...styles.sendBtn, opacity: (!input.trim() || loading) ? 0.4 : 1 }}
              onClick={send}
              disabled={!input.trim() || loading}
              aria-label="Send"
            >
              ↑
            </button>
          </div>
        </div>
      )}

      {/* Bubble trigger */}
      <button
        style={styles.bubble}
        onClick={() => open ? handleClose() : setOpen(true)}
        aria-label={open ? 'Close support chat' : 'Open support chat'}
      >
        {open ? '✕' : (
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M20 2H4C2.9 2 2 2.9 2 4V22L6 18H20C21.1 18 22 17.1 22 16V4C22 2.9 21.1 2 20 2Z" fill="white"/>
          </svg>
        )}
      </button>
    </>
  );
}

const styles = {
  bubble: {
    position: 'fixed',
    bottom: 24,
    right: 24,
    width: 56,
    height: 56,
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #2563eb, #1e40af)',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: '0 4px 16px rgba(37,99,235,0.4)',
    zIndex: 9999,
    color: 'white',
    fontSize: 20,
    transition: 'transform 0.15s ease',
  },
  panel: {
    position: 'fixed',
    bottom: 92,
    right: 24,
    width: 360,
    maxHeight: 520,
    background: '#fff',
    borderRadius: 16,
    boxShadow: '0 8px 40px rgba(0,0,0,0.18)',
    display: 'flex',
    flexDirection: 'column',
    zIndex: 9998,
    overflow: 'hidden',
    fontFamily: 'system-ui, -apple-system, sans-serif',
  },
  header: {
    background: 'linear-gradient(135deg, #2563eb, #1e40af)',
    padding: '14px 16px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  avatar: {
    width: 36,
    height: 36,
    borderRadius: '50%',
    background: 'rgba(255,255,255,0.25)',
    color: 'white',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 700,
    fontSize: 13,
  },
  headerTitle: {
    color: 'white',
    fontWeight: 600,
    fontSize: 15,
  },
  headerSub: {
    color: 'rgba(255,255,255,0.75)',
    fontSize: 12,
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    color: 'white',
    cursor: 'pointer',
    fontSize: 16,
    padding: 4,
    opacity: 0.8,
  },
  messages: {
    flex: 1,
    overflowY: 'auto',
    padding: '16px 14px',
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    minHeight: 200,
    maxHeight: 360,
  },
  userBubbleWrap: { display: 'flex', justifyContent: 'flex-end' },
  botBubbleWrap: { display: 'flex', justifyContent: 'flex-start' },
  userBubble: {
    background: '#2563eb',
    color: 'white',
    borderRadius: '16px 16px 4px 16px',
    padding: '9px 13px',
    maxWidth: '80%',
    fontSize: 14,
    lineHeight: 1.45,
  },
  botBubble: {
    background: '#f1f5f9',
    color: '#1e293b',
    borderRadius: '16px 16px 16px 4px',
    padding: '9px 13px',
    maxWidth: '85%',
    fontSize: 14,
    lineHeight: 1.45,
  },
  inputRow: {
    padding: '10px 12px',
    borderTop: '1px solid #f1f5f9',
    display: 'flex',
    gap: 8,
    alignItems: 'flex-end',
  },
  textarea: {
    flex: 1,
    border: '1px solid #e2e8f0',
    borderRadius: 10,
    padding: '8px 12px',
    fontSize: 14,
    resize: 'none',
    outline: 'none',
    fontFamily: 'inherit',
    lineHeight: 1.4,
    maxHeight: 100,
    overflowY: 'auto',
  },
  sendBtn: {
    width: 36,
    height: 36,
    borderRadius: '50%',
    background: '#2563eb',
    color: 'white',
    border: 'none',
    cursor: 'pointer',
    fontSize: 18,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
};
