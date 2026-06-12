// Integrations — connect calendars, CRM, practice management, and SIP providers.
// OAuth providers: server-side redirect flow (Connect button → provider → callback → back here).
// Telnyx: API key form (no OAuth).
// SIP providers (RingCentral, Vonage, Telnyx): OAuth/key + secondary Configure action after linking.

import { useState, useEffect } from 'react';
import { useFetch } from '../../lib/useFetch';
import { api } from '../../lib/api';
import { Loading, ErrorState } from '../../components/States';
import { Badge } from '../../components/Badge';
import { formatDate } from '../../lib/format';

// ── Provider definitions ──────────────────────────────────────────────────────

const SECTIONS = [
  {
    id: 'calendar',
    title: 'Calendar',
    description: 'Connect your calendar so the AI receptionist can check availability, book appointments, and send proactive call reminders.',
    providers: [
      {
        id: 'google_calendar',
        name: 'Google Calendar',
        description: 'Book appointments into Google Calendar. Attendees from upcoming events are available to Outbound Call Assist, and reminders fire before Google Calendar events.',
        logo: '🗓️',
        oauth: true,
      },
      {
        id: 'microsoft_calendar',
        name: 'Microsoft Calendar',
        description: 'Book appointments into Outlook and Microsoft 365 calendars. Required for Outbound Call Assist reminders on Microsoft accounts.',
        logo: '📅',
        oauth: true,
      },
    ],
  },
  {
    id: 'crm',
    title: 'CRM',
    description: 'Sync contacts and log call activity automatically.',
    providers: [
      {
        id: 'hubspot',
        name: 'HubSpot',
        description: 'Create contacts and log calls in HubSpot CRM. Contact names from HubSpot are available to Outbound Call Assist.',
        logo: '🟠',
        oauth: true,
      },
      {
        id: 'salesforce',
        name: 'Salesforce',
        description: 'Create Leads and log call Tasks in Salesforce. Supports Contact and Lead lookup for outbound dialing.',
        logo: '☁️',
        oauth: true,
      },
    ],
  },
  {
    id: 'practice',
    title: 'Practice Management',
    description: 'For law firms, medical offices, and accountants — sync contacts and time entries with your existing software.',
    providers: [
      {
        id: 'clio',
        name: 'Clio',
        description: 'Connect Clio Manage to sync contacts and push billable time entries directly into your matters.',
        logo: '⚖️',
        oauth: true,
      },
      {
        id: 'mycase',
        name: 'MyCase',
        description: 'Sync call activity and time entries with MyCase. Notes flow directly into your cases.',
        logo: '📋',
        oauth: true,
      },
    ],
  },
  {
    id: 'sip',
    title: 'Phone System',
    description: 'Keep your existing phone number. Connect your phone system so calls route through your AI receptionist.',
    providers: [
      {
        id: 'ringcentral',
        name: 'RingCentral',
        description: 'Link your RingCentral account, then configure call forwarding to route inbound calls to your AI receptionist number.',
        logo: '📞',
        oauth: true,
        hasConfigureAction: true,
        configureLabel: 'Configure Forwarding',
        configureEndpoint: '/integrations/ringcentral/configure-forwarding',
        configureHint: 'Updates your RingCentral answering rule to forward calls to your SoCal Receptionist number.',
      },
      {
        id: 'vonage',
        name: 'Vonage Business',
        description: 'Link your Vonage Business account, then set up the inbound call webhook to route calls through your AI receptionist.',
        logo: '🔵',
        oauth: true,
        hasConfigureAction: true,
        configureLabel: 'Configure Webhook',
        configureEndpoint: '/integrations/vonage/configure-webhook',
        configureHint: 'Updates your Vonage Business call handling to send inbound calls to your AI receptionist.',
      },
      {
        id: 'telnyx',
        name: 'Telnyx',
        description: 'Enter your Telnyx API key, then configure an inbound profile to route calls through your AI receptionist.',
        logo: '🟢',
        oauth: false,
        apiKey: true,
        hasConfigureAction: true,
        configureLabel: 'Configure Inbound Profile',
        configureEndpoint: '/integrations/telnyx/configure-inbound-profile',
        configureHint: 'Creates or updates a Telnyx Voice Inbound Profile pointing to your AI receptionist.',
      },
    ],
  },
];

// ── OAuth card ────────────────────────────────────────────────────────────────

function OAuthCard({ provider, integration, onDisconnect, onConfigure, apiBase }) {
  const [disconnecting, setDisconnecting] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [configMsg, setConfigMsg] = useState(null);
  const connected = !!integration;
  const hasError = !!integration?.last_error;

  async function handleDisconnect() {
    if (!confirm(`Disconnect ${provider.name}? This won't delete your data in ${provider.name}.`)) return;
    setDisconnecting(true);
    try { await onDisconnect(provider.id); } finally { setDisconnecting(false); }
  }

  async function handleConfigure() {
    setConfiguring(true);
    setConfigMsg(null);
    try {
      await onConfigure(provider.configureEndpoint);
      setConfigMsg({ ok: true, text: 'Configured successfully.' });
    } catch (err) {
      setConfigMsg({ ok: false, text: err.message || 'Configuration failed.' });
    } finally {
      setConfiguring(false);
    }
  }

  return (
    <div className={`integration-card ${connected ? 'connected' : ''}`}>
      <div className="integration-header">
        <span className="integration-logo">{provider.logo}</span>
        <div className="integration-title">
          <h3>{provider.name}</h3>
          <Badge color={connected ? (hasError ? 'yellow' : 'green') : 'gray'}>
            {connected ? (hasError ? 'Error' : 'Connected') : 'Not connected'}
          </Badge>
        </div>
      </div>

      <p className="integration-desc">{provider.description}</p>

      {connected && (
        <div className="integration-meta">
          {integration.extra?.firm_name    && <div><strong>Firm:</strong> {integration.extra.firm_name}</div>}
          {integration.extra?.display_name && <div><strong>Account:</strong> {integration.extra.display_name}</div>}
          {integration.extra?.hub_domain   && <div><strong>Hub:</strong> {integration.extra.hub_domain}</div>}
          {integration.extra?.org_id       && <div><strong>Org:</strong> {integration.extra.org_id}</div>}
          {integration.extra?.account_id   && <div><strong>Account ID:</strong> {integration.extra.account_id}</div>}
          {integration.last_sync_at        && <div><strong>Last sync:</strong> {formatDate(integration.last_sync_at)}</div>}
          {hasError && <div className="integration-error"><strong>Error:</strong> {integration.last_error}</div>}
        </div>
      )}

      {configMsg && (
        <div className={`alert ${configMsg.ok ? 'alert-success' : 'alert-error'}`} style={{ marginTop: 8 }}>
          {configMsg.text}
        </div>
      )}

      {provider.hasConfigureAction && connected && provider.configureHint && (
        <p className="hint" style={{ marginTop: 6 }}>{provider.configureHint}</p>
      )}

      <div className="integration-actions">
        {connected ? (
          <>
            {provider.hasConfigureAction && (
              <button
                className="btn btn-primary btn-sm"
                onClick={handleConfigure}
                disabled={configuring}
              >
                {configuring ? 'Configuring…' : provider.configureLabel}
              </button>
            )}
            <button
              className="btn btn-secondary btn-sm"
              onClick={handleDisconnect}
              disabled={disconnecting}
            >
              {disconnecting ? 'Disconnecting…' : 'Disconnect'}
            </button>
          </>
        ) : (
          <a
            href={`${apiBase}/integrations/${provider.id}/connect`}
            className="btn btn-primary btn-sm"
          >
            Connect {provider.name}
          </a>
        )}
      </div>
    </div>
  );
}

// ── API key card (Telnyx) ─────────────────────────────────────────────────────

function ApiKeyCard({ provider, integration, onDisconnect, onConfigure, onSaveApiKey }) {
  const [key, setKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [configMsg, setConfigMsg] = useState(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const connected = !!integration;
  const hasError = !!integration?.last_error;

  async function handleSave(e) {
    e.preventDefault();
    if (!key.trim()) return;
    setSaving(true);
    try {
      await onSaveApiKey(provider.id, key.trim());
      setKey('');
    } finally {
      setSaving(false);
    }
  }

  async function handleConfigure() {
    setConfiguring(true);
    setConfigMsg(null);
    try {
      await onConfigure(provider.configureEndpoint);
      setConfigMsg({ ok: true, text: 'Inbound profile configured.' });
    } catch (err) {
      setConfigMsg({ ok: false, text: err.message || 'Configuration failed.' });
    } finally {
      setConfiguring(false);
    }
  }

  async function handleDisconnect() {
    if (!confirm(`Disconnect ${provider.name}?`)) return;
    setDisconnecting(true);
    try { await onDisconnect(provider.id); } finally { setDisconnecting(false); }
  }

  return (
    <div className={`integration-card ${connected ? 'connected' : ''}`}>
      <div className="integration-header">
        <span className="integration-logo">{provider.logo}</span>
        <div className="integration-title">
          <h3>{provider.name}</h3>
          <Badge color={connected ? (hasError ? 'yellow' : 'green') : 'gray'}>
            {connected ? (hasError ? 'Error' : 'Connected') : 'Not connected'}
          </Badge>
        </div>
      </div>

      <p className="integration-desc">{provider.description}</p>

      {connected && (
        <div className="integration-meta">
          {integration.last_sync_at && <div><strong>Last sync:</strong> {formatDate(integration.last_sync_at)}</div>}
          {hasError && <div className="integration-error"><strong>Error:</strong> {integration.last_error}</div>}
        </div>
      )}

      {!connected && (
        <form onSubmit={handleSave} style={{ marginTop: 10 }}>
          <label className="field" style={{ marginBottom: 6 }}>
            <span className="label">Telnyx API Key</span>
            <input
              type="password"
              value={key}
              onChange={e => setKey(e.target.value)}
              placeholder="KEY_..."
              autoComplete="off"
            />
            <span className="hint">Found in the Telnyx Portal under API Keys. Stored encrypted.</span>
          </label>
          <button className="btn btn-primary btn-sm" type="submit" disabled={saving || !key.trim()}>
            {saving ? 'Saving…' : 'Save API Key'}
          </button>
        </form>
      )}

      {configMsg && (
        <div className={`alert ${configMsg.ok ? 'alert-success' : 'alert-error'}`} style={{ marginTop: 8 }}>
          {configMsg.text}
        </div>
      )}

      {connected && provider.configureHint && (
        <p className="hint" style={{ marginTop: 6 }}>{provider.configureHint}</p>
      )}

      {connected && (
        <div className="integration-actions">
          {provider.hasConfigureAction && (
            <button className="btn btn-primary btn-sm" onClick={handleConfigure} disabled={configuring}>
              {configuring ? 'Configuring…' : provider.configureLabel}
            </button>
          )}
          <button className="btn btn-secondary btn-sm" onClick={handleDisconnect} disabled={disconnecting}>
            {disconnecting ? 'Disconnecting…' : 'Disconnect'}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function IntegrationSettings() {
  const { data, loading, error, reload } = useFetch('/integrations');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const integration = params.get('integration');
    const status = params.get('status');
    if (integration && status) {
      if (status === 'connected') reload();
      const url = new URL(window.location);
      url.searchParams.delete('integration');
      url.searchParams.delete('status');
      url.searchParams.delete('msg');
      window.history.replaceState({}, '', url);
    }
  }, [reload]);

  async function handleDisconnect(providerId) {
    try {
      await api.delete(`/integrations/${providerId}`);
      reload();
    } catch (err) {
      alert(`Failed to disconnect: ${err.message}`);
    }
  }

  async function handleConfigure(endpoint) {
    await api.post(endpoint, {});
  }

  async function handleSaveApiKey(providerId, apiKey) {
    try {
      await api.post(`/integrations/${providerId}/connect`, { api_key: apiKey });
      reload();
    } catch (err) {
      alert(`Failed to save API key: ${err.message}`);
    }
  }

  if (loading) return <Loading label="Loading integrations…" />;
  if (error) return <ErrorState message={error} />;

  const integrations = data?.integrations || [];
  const byProvider = Object.fromEntries(integrations.map(i => [i.provider, i]));
  const apiBase = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Integrations</h1>
          <p className="page-sub">
            Connect your calendar, CRM, and phone system. All connections use OAuth — no passwords stored.
          </p>
        </div>
      </div>

      {SECTIONS.map(section => (
        <div key={section.id} className="integration-section">
          <div className="integration-section-header">
            <h2>{section.title}</h2>
            <p className="muted" style={{ fontSize: '0.86rem', marginTop: 2 }}>{section.description}</p>
          </div>

          <div className="integrations-grid">
            {section.providers.map(provider => {
              const integration = byProvider[provider.id] || null;
              if (provider.apiKey) {
                return (
                  <ApiKeyCard
                    key={provider.id}
                    provider={provider}
                    integration={integration}
                    onDisconnect={handleDisconnect}
                    onConfigure={handleConfigure}
                    onSaveApiKey={handleSaveApiKey}
                  />
                );
              }
              return (
                <OAuthCard
                  key={provider.id}
                  provider={provider}
                  integration={integration}
                  onDisconnect={handleDisconnect}
                  onConfigure={handleConfigure}
                  apiBase={apiBase}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
