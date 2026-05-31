import { useState } from 'react';

export default function CookieBanner() {
  const [visible, setVisible] = useState(() => !localStorage.getItem('cookie_consent'));

  if (!visible) return null;

  const handle = (accepted) => {
    localStorage.setItem('cookie_consent', accepted ? 'accepted' : 'declined');
    setVisible(false);
  };

  return (
    <div style={{
      position: 'fixed',
      bottom: 0,
      left: 0,
      right: 0,
      background: '#0f1f3d',
      color: '#fff',
      padding: '14px 20px',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 16,
      zIndex: 9999,
      flexWrap: 'wrap',
      fontSize: '0.875rem',
      boxShadow: '0 -2px 12px rgba(0,0,0,0.2)',
    }}>
      <p style={{ margin: 0, flex: 1 }}>
        We use cookies to improve your experience and analyze site usage. See our{' '}
        <a href="https://www.socalreceptionist.com/cookies" style={{ color: '#f97316', textDecoration: 'underline' }}>
          Cookie Policy
        </a>.
      </p>
      <div style={{ display: 'flex', gap: 10, flexShrink: 0 }}>
        <button
          onClick={() => handle(false)}
          style={{
            padding: '6px 16px',
            borderRadius: 6,
            border: '1px solid rgba(255,255,255,0.3)',
            background: 'transparent',
            color: '#fff',
            cursor: 'pointer',
            fontSize: '0.85rem',
          }}
        >
          Decline
        </button>
        <button
          onClick={() => handle(true)}
          style={{
            padding: '6px 16px',
            borderRadius: 6,
            border: 'none',
            background: '#f97316',
            color: '#fff',
            cursor: 'pointer',
            fontWeight: 600,
            fontSize: '0.85rem',
          }}
        >
          Accept
        </button>
      </div>
    </div>
  );
}
