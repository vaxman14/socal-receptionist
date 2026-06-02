// Conversational onboarding wizard.
// Replaces the form-based StepBusiness with a chat interface.
// When Claude signals done, shows a confirm card before submitting.

import { useState, useRef, useEffect } from 'react';
import { api } from '../../lib/api';

const CHAT_KEY = 'socal_chat_wizard';

function loadChat() {
  try { const s = sessionStorage.getItem(CHAT_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
}

const TIMEZONES = [
  'America/Los_Angeles', 'America/Denver', 'America/Chicago',
  'America/New_York', 'America/Phoenix', 'America/Anchorage', 'Pacific/Honolulu',
];

export default function ChatWizard({ onCreated }) {
  const saved = loadChat();
  const [messages, setMessages] = useState(saved?.messages || []);
  const [input, setInput] = useState('');
  const [thinking, setThinking] = useState(false);
  const [profile, setProfile] = useState(saved?.profile || null);
  const [confirming, setConfirming] = useState(false);
  const [confirmForm, setConfirmForm] = useState(saved?.profile || null);
  const [submitError, setSubmitError] = useState(null);
  const bottomRef = useRef(null);
  const inputRef = useRef(null);

  // Kick off the conversation only if there's no saved history.
  useEffect(() => { if (!saved?.messages?.length) sendToAI([]); }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, thinking]);

  useEffect(() => {
    try { sessionStorage.setItem(CHAT_KEY, JSON.stringify({ messages, profile })); } catch {}
  }, [messages, profile]);

  async function sendToAI(history) {
    setThinking(true);
    try {
      const data = await api.post('/onboarding/chat', { messages: history });
      const aiMsg = { role: 'assistant', content: data.message };
      setMessages((prev) => [...prev, aiMsg]);
      if (data.done && data.profile) {
        setProfile(data.profile);
        setConfirmForm({ ...data.profile });
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: "Sorry, I hit a snag. Mind trying again?" },
      ]);
    } finally {
      setThinking(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }

  function send() {
    const text = input.trim();
    if (!text || thinking || profile) return;
    const userMsg = { role: 'user', content: text };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput('');
    sendToAI(next);
  }

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  }

  // Confirm screen — editable summary before final submit.
  async function submit(e) {
    e.preventDefault();
    setSubmitError(null);
    if (!confirmForm.business_name?.trim()) {
      setSubmitError('Business name is required.'); return;
    }
    if (!confirmForm.staff_phone?.trim()) {
      setSubmitError('Staff transfer number is required.'); return;
    }
    setConfirming(true);
    try {
      const body = {};
      for (const [k, v] of Object.entries(confirmForm)) {
        if (v !== null && v !== undefined && String(v).trim()) body[k] = String(v).trim();
      }
      const data = await api.post('/onboarding/business', body);
      try { sessionStorage.removeItem(CHAT_KEY); } catch {}
      onCreated(data.tenant);
    } catch (err) {
      setSubmitError(err.message || 'Could not create your business.');
    } finally {
      setConfirming(false);
    }
  }

  const setField = (k) => (e) => setConfirmForm((f) => ({ ...f, [k]: e.target.value }));

  if (profile) {
    return (
      <div className="card card-pad">
        <h2 style={{ marginBottom: 6 }}>Looks good?</h2>
        <p className="muted" style={{ marginBottom: 20, fontSize: '0.9rem' }}>
          Review your profile below. Edit anything before we set you up.
        </p>
        {submitError && <div className="alert alert-error">{submitError}</div>}
        <form onSubmit={submit}>
          <label className="field">
            <span className="label">Business name *</span>
            <input type="text" value={confirmForm.business_name || ''} onChange={setField('business_name')} />
          </label>
          <label className="field">
            <span className="label">Business hours</span>
            <textarea rows={8} value={confirmForm.business_hours || ''} onChange={setField('business_hours')} />
          </label>
          <label className="field">
            <span className="label">Services</span>
            <textarea value={confirmForm.business_services || ''} onChange={setField('business_services')} />
          </label>
          <label className="field">
            <span className="label">Booking link</span>
            <input type="url" value={confirmForm.calendly_link || ''} onChange={setField('calendly_link')} />
          </label>
          <label className="field">
            <span className="label">Staff transfer number *</span>
            <input type="tel" value={confirmForm.staff_phone || ''} onChange={setField('staff_phone')} />
          </label>
          <label className="field">
            <span className="label">Voicemail email</span>
            <input type="email" value={confirmForm.voicemail_email || ''} onChange={setField('voicemail_email')} />
          </label>
          <label className="field" style={{ marginBottom: 20 }}>
            <span className="label">Timezone</span>
            <select value={confirmForm.timezone || 'America/Los_Angeles'} onChange={setField('timezone')}>
              {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </label>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn btn-primary" disabled={confirming} type="submit">
              {confirming ? 'Setting up…' : 'Looks good — continue →'}
            </button>
            <button type="button" className="btn btn-secondary" onClick={() => { setProfile(null); setConfirmForm(null); setMessages([]); try { sessionStorage.removeItem(CHAT_KEY); } catch {} sendToAI([]); }}>
              Start over
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div className="card card-pad chat-wizard">
      <h2 style={{ marginBottom: 4 }}>Let's set up your receptionist</h2>
      <p className="muted" style={{ fontSize: '0.88rem', marginBottom: 16 }}>
        Just chat — I'll take care of the rest.
      </p>

      <div className="chat-messages">
        {messages.map((m, i) => (
          <div key={i} className={`chat-bubble chat-bubble-${m.role}`}>
            {m.content}
          </div>
        ))}
        {thinking && (
          <div className="chat-bubble chat-bubble-assistant chat-thinking">
            <span /><span /><span />
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="chat-input-row">
        <textarea
          ref={inputRef}
          className="chat-input"
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKey}
          placeholder="Type your answer…"
          disabled={thinking}
        />
        <button
          className="btn btn-primary chat-send"
          onClick={send}
          disabled={!input.trim() || thinking}
        >
          Send
        </button>
      </div>
      <p className="muted" style={{ fontSize: '0.75rem', marginTop: 6 }}>
        Press Enter to send · Shift+Enter for new line
      </p>
    </div>
  );
}
