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

// Every integration is currently Beta (outside the core V2 product). Connectors
// without a backend yet are marked comingSoon so they show but don't try to connect.
const SECTIONS = [
  {
    id: 'calendar',
    title: 'Calendar',
    description: 'Connect your calendar so the AI receptionist can check availability, book appointments, and send proactive call reminders.',
    providers: [
      { id: 'google_calendar', name: 'Google Calendar', logo: '🗓️', oauth: true, beta: true,
        description: 'Book appointments into Google Calendar. Attendees from upcoming events are available to Outbound Call Assist, and reminders fire before Google Calendar events.' },
      { id: 'microsoft_calendar', name: 'Microsoft Calendar', logo: '📅', oauth: true, beta: true,
        description: 'Book appointments into Outlook and Microsoft 365 calendars. Required for Outbound Call Assist reminders on Microsoft accounts.' },
    ],
  },
  {
    id: 'crm',
    title: 'CRM',
    description: 'Sync contacts and log call activity automatically.',
    providers: [
      { id: 'hubspot', name: 'HubSpot', logo: '🟠', oauth: true, beta: true,
        description: 'Create contacts and log calls in HubSpot CRM. Contact names from HubSpot are available to Outbound Call Assist.' },
      { id: 'salesforce', name: 'Salesforce', logo: '☁️', oauth: true, beta: true,
        description: 'Create Leads and log call Tasks in Salesforce. Supports Contact and Lead lookup for outbound dialing.' },
    ],
  },
  {
    id: 'legal',
    title: 'Legal',
    description: 'For law firms — push captured callers into your case software and book consultations.',
    providers: [
      { id: 'clio', name: 'Clio', logo: '⚖️', oauth: true, beta: true,
        description: 'Connect Clio Manage to create contacts/matters from calls and push call notes and time entries.' },
      { id: 'mycase', name: 'MyCase', logo: '📋', oauth: true, beta: true,
        description: 'Create contacts and log call activity and time entries in MyCase. Notes flow into your cases.' },
      { id: 'practicepanther', name: 'PracticePanther', logo: '🐾', oauth: true, beta: true, comingSoon: true,
        description: 'Create contacts and matters and log call activity in PracticePanther.' },
    ],
  },
  {
    id: 'medical',
    title: 'Medical',
    description: 'For medical practices — turn callers into patients and book visits in your EHR.',
    providers: [
      { id: 'drchrono', name: 'DrChrono', logo: '🩺', oauth: true, beta: true, comingSoon: true,
        description: 'Create patients and book appointments in DrChrono from inbound calls.' },
      { id: 'athenahealth', name: 'athenahealth', logo: '🏥', oauth: true, beta: true, comingSoon: true,
        description: 'Create patients and appointments in athenahealth. Requires partner access.' },
      { id: 'simplepractice', name: 'SimplePractice', logo: '🧠', oauth: true, beta: true, comingSoon: true,
        description: 'Create clients and book appointments in SimplePractice.' },
    ],
  },
  {
    id: 'dental',
    title: 'Dental',
    description: 'For dental offices — create patients and book appointments in your practice software.',
    providers: [
      { id: 'opendental', name: 'Open Dental', logo: '🦷', oauth: true, beta: true, comingSoon: true,
        description: 'Create patients and appointments in Open Dental via its API.' },
      { id: 'dentrix', name: 'Dentrix', logo: '🦷', oauth: true, beta: true, comingSoon: true,
        description: 'Sync patients and appointments with Dentrix. Requires a Dentrix integration partner key.' },
      { id: 'eaglesoft', name: 'Eaglesoft', logo: '🦷', oauth: true, beta: true, comingSoon: true,
        description: 'Sync patients and appointments with Eaglesoft. Requires partner access.' },
    ],
  },
  {
    id: 'accounting',
    title: 'Accounting / CPA',
    description: 'For accountants and bookkeepers — turn callers into clients and log them in your software.',
    providers: [
      { id: 'quickbooks', name: 'QuickBooks', logo: '💵', oauth: true, beta: true, comingSoon: true,
        description: 'Create customers and log call activity in QuickBooks Online.' },
      { id: 'karbon', name: 'Karbon', logo: '📊', oauth: true, beta: true, comingSoon: true,
        description: 'Create contacts and work items in Karbon from inbound calls.' },
      { id: 'taxdome', name: 'TaxDome', logo: '🧾', oauth: true, beta: true, comingSoon: true,
        description: 'Create contacts/accounts and log calls in TaxDome.' },
    ],
  },
  {
    id: 'homeservices',
    title: 'Home Services / Trades',
    description: 'For plumbers, electricians, handymen, and general contractors — turn calls into jobs and book them.',
    providers: [
      { id: 'jobber', name: 'Jobber', logo: '🔧', oauth: true, beta: true, comingSoon: true,
        description: 'Create clients and book jobs in Jobber from inbound calls.' },
      { id: 'housecallpro', name: 'Housecall Pro', logo: '🛠️', oauth: true, beta: true, comingSoon: true,
        description: 'Create customers and schedule jobs in Housecall Pro.' },
      { id: 'servicetitan', name: 'ServiceTitan', logo: '🏗️', oauth: true, beta: true, comingSoon: true,
        description: 'Create customers and bookings in ServiceTitan. Requires partner access.' },
    ],
  },
  {
    id: 'sip',
    title: 'Phone System',
    description: 'Keep your existing phone number. Connect your phone system so calls route through your AI receptionist.',
    providers: [
      { id: 'ringcentral', name: 'RingCentral', logo: '📞', oauth: true, beta: true,
        description: 'Link your RingCentral account, then configure call forwarding to route inbound calls to your AI receptionist number.',
        hasConfigureAction: true, configureLabel: 'Configure Forwarding',
        configureEndpoint: '/integrations/ringcentral/configure-forwarding',
        configureHint: 'Updates your RingCentral answering rule to forward calls to your SoCal Receptionist number.' },
      { id: 'vonage', name: 'Vonage Business', logo: '🔵', oauth: true, beta: true,
        description: 'Link your Vonage Business account, then set up the inbound call webhook to route calls through your AI receptionist.',
        hasConfigureAction: true, configureLabel: 'Configure Webhook',
        configureEndpoint: '/integrations/vonage/configure-webhook',
        configureHint: 'Updates your Vonage Business call handling to send inbound calls to your AI receptionist.' },
      { id: 'telnyx', name: 'Telnyx', logo: '🟢', oauth: false, apiKey: true, beta: true,
        description: 'Enter your Telnyx API key, then configure an inbound profile to route calls through your AI receptionist.',
        hasConfigureAction: true, configureLabel: 'Configure Inbound Profile',
        configureEndpoint: '/integrations/telnyx/configure-inbound-profile',
        configureHint: 'Creates or updates a Telnyx Voice Inbound Profile pointing to your AI receptionist.' },
    ],
  },
];

// ── OAuth card ────────────────────────────────────────────────────────────────

function OAuthCard({ provider, integration, onDisconnect, onConfigure, onConnect }) {
  const [disconnecting, setDisconnecting] = useState(false);
  const [configuring, setConfiguring] = useState(false);
  const [configMsg, setConfigMsg] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [connectErr, setConnectErr] = useState(null);
  const connected = !!integration;
  const hasError = !!integration?.last_error;

  async function handleDisconnect() {
    if (!confirm(`Disconnect ${provider.name}? This won't delete your data in ${provider.name}.`)) return;
    setDisconnecting(true);
    try { await onDisconnect(provider.id); } finally { setDisconnecting(false); }
  }

  async function handleConnect() {
    setConnecting(true);
    setConnectErr(null);
    try {
      await onConnect(provider.id);
    } catch (err) {
      // requireAal2 on the connect route surfaces as a 401/403 — point the user
      // at MFA rather than showing a raw error.
      const msg = err?.status === 401 || err?.status === 403
        ? 'Enable two-factor authentication in Settings → Security before connecting.'
        : (err?.message || `Could not start the ${provider.name} connection.`);
      setConnectErr(msg);
      setConnecting(false);
    }
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
          {provider.beta && <span className="badge badge-info">Beta</span>}
          <span className={`badge badge-${connected ? (hasError ? 'warn' : 'green') : 'gray'}`}>
            {connected ? (hasError ? 'Error' : 'Connected') : (provider.comingSoon ? 'Coming soon' : 'Not connected')}
          </span>
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

      {connectErr && (
        <div className="alert alert-error" style={{ marginTop: 8 }}>{connectErr}</div>
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
        ) : provider.comingSoon ? (
          <button className="btn btn-secondary btn-sm" disabled title="Coming soon — contact us to enable for your account">
            Coming soon
          </button>
        ) : (
          <button
            className="btn btn-primary btn-sm"
            onClick={handleConnect}
            disabled={connecting}
          >
            {connecting ? 'Connecting…' : `Connect ${provider.name}`}
          </button>
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
          {provider.beta && <span className="badge badge-info">Beta</span>}
          <span className={`badge badge-${connected ? (hasError ? 'warn' : 'green') : 'gray'}`}>
            {connected ? (hasError ? 'Error' : 'Connected') : 'Not connected'}
          </span>
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
  const [flash, setFlash] = useState(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const integration = params.get('integration');
    const status = params.get('status');
    if (integration && status) {
      const msg = params.get('msg');
      if (status === 'connected') {
        setFlash({ ok: true, text: `${integration} connected.` });
        reload();
      } else if (status === 'error') {
        // Surface the real reason instead of silently bouncing back to "Connect".
        setFlash({ ok: false, text: `Couldn't connect ${integration}: ${msg ? decodeURIComponent(msg) : 'authorization failed'}` });
      }
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

  // Start an OAuth connection. The connect endpoint requires the bearer token,
  // so we fetch it (authenticated) to get the provider authorize URL, then send
  // the browser there. A plain link can't carry the token — that was the
  // "missing bearer token" bug.
  async function handleConnect(providerId) {
    const { url } = await api.get(`/integrations/${providerId}/connect`);
    if (!url) throw new Error('No authorization URL returned.');
    window.location.href = url;
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

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Integrations</h1>
          <p className="page-sub">
            Connect the software your business already runs. All connections use OAuth — no passwords stored.
          </p>
        </div>
      </div>

      <div className="alert" style={{ marginBottom: 16, background: '#eef2ff', border: '1px solid #c7d2fe', color: '#3730a3' }}>
        <strong>Beta:</strong> Integrations are part of our newest release and are still in beta. Connectors marked “Coming soon” are on the way — contact us to enable one early for your account.
      </div>

      {flash && (
        <div className={`alert ${flash.ok ? 'alert-success' : 'alert-error'}`} style={{ marginBottom: 16 }}>
          {flash.text}
        </div>
      )}

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
                  onConnect={handleConnect}
                />
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
