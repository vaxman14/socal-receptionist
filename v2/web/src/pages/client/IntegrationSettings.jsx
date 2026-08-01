import { useEffect, useState } from 'react';
import { useFetch } from '../../lib/useFetch';
import { api } from '../../lib/api';
import { Loading, ErrorState } from '../../components/States';
import { formatDate } from '../../lib/format';

const PROVIDERS = [
  {
    id: 'google_calendar',
    name: 'Google Calendar',
    logo: '🗓️',
    description: 'Let your receptionist check availability and book callers into your Google Calendar.',
  },
  {
    id: 'microsoft_calendar',
    name: 'Microsoft Outlook Calendar',
    logo: '📅',
    description: 'Let your receptionist check availability and book callers into Microsoft 365 or Outlook.',
  },
];

function CalendarCard({ provider, integration, onConnect, onDisconnect }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const connected = !!integration;

  async function connect() {
    setBusy(true); setError(null);
    try { await onConnect(provider.id); }
    catch (err) { setError(err?.message || `Could not connect ${provider.name}.`); setBusy(false); }
  }

  async function disconnect() {
    if (!window.confirm(`Disconnect ${provider.name}? New callers will be captured as leads instead of booked.`)) return;
    setBusy(true); setError(null);
    try { await onDisconnect(provider.id); }
    catch (err) { setError(err?.message || `Could not disconnect ${provider.name}.`); }
    finally { setBusy(false); }
  }

  return (
    <div className={`integration-card ${connected ? 'connected' : ''}`}>
      <div className="integration-header">
        <span className="integration-logo">{provider.logo}</span>
        <div className="integration-title">
          <h3>{provider.name}</h3>
          <span className={`badge badge-${connected ? 'green' : 'gray'}`}>{connected ? 'Connected' : 'Not connected'}</span>
        </div>
      </div>
      <p className="integration-desc">{provider.description}</p>
      {connected && integration.last_sync_at && <p className="muted" style={{ fontSize: '0.8rem' }}>Last synced {formatDate(integration.last_sync_at)}</p>}
      {(error || integration?.last_error) && <div className="alert alert-error">{error || integration.last_error}</div>}
      <div className="integration-actions">
        <button className={`btn ${connected ? 'btn-secondary' : 'btn-primary'} btn-sm`} disabled={busy} onClick={connected ? disconnect : connect}>
          {busy ? 'Working…' : connected ? 'Disconnect' : `Connect ${provider.name}`}
        </button>
      </div>
    </div>
  );
}

export default function IntegrationSettings() {
  const { data, loading, error, reload } = useFetch('/integrations');
  const [flash, setFlash] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const integration = params.get('integration');
    const status = params.get('status');
    if (!integration || !status) return;
    const provider = PROVIDERS.find((item) => item.id === integration);
    const label = provider?.name || integration;
    setFlash(status === 'connected'
      ? { ok: true, text: `${label} connected. You can enable booking in Settings.` }
      : { ok: false, text: `Couldn't connect ${label}: ${params.get('msg') || 'authorization failed'}` });
    if (status === 'connected') reload();
    const url = new URL(window.location);
    ['integration', 'status', 'msg'].forEach((key) => url.searchParams.delete(key));
    window.history.replaceState({}, '', url);
  }, [reload]);

  async function connect(providerId) {
    const { url } = await api.get(`/integrations/${providerId}/connect`);
    if (!url) throw new Error('No authorization URL returned.');
    window.location.href = url;
  }

  async function disconnect(providerId) {
    await api.delete(`/integrations/${providerId}`);
    reload();
  }

  if (loading) return <Loading label="Loading calendars…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  const byProvider = Object.fromEntries((data?.integrations || []).map((item) => [item.provider, item]));
  return (
    <div className="page">
      <div className="page-header"><div><h1>Calendar</h1><p className="page-sub">Calendar connection is optional. Without one, your receptionist captures the lead and emails you the caller's details.</p></div></div>
      <div className="alert alert-info" style={{ marginBottom: 16 }}>Connect one calendar if you want callers to schedule during the call. You can leave both disconnected and use lead capture only.</div>
      {flash && <div className={`alert ${flash.ok ? 'alert-success' : 'alert-error'}`} style={{ marginBottom: 16 }}>{flash.text}</div>}
      <div className="integrations-grid">
        {PROVIDERS.map((provider) => <CalendarCard key={provider.id} provider={provider} integration={byProvider[provider.id] || null} onConnect={connect} onDisconnect={disconnect} />)}
      </div>
    </div>
  );
}
