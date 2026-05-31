// Practice Management Integrations — connect Clio, MyCase, and future providers.
// OAuth flows are server-side redirects; this page shows status + connect/disconnect.

import { useState, useEffect } from 'react';
import { useFetch } from '../../lib/useFetch';
import { api } from '../../lib/api';
import { Loading, ErrorState } from '../../components/States';
import { Badge } from '../../components/Badge';
import { formatDate } from '../../lib/format';

const PROVIDERS = [
  {
    id: 'clio',
    name: 'Clio',
    description: 'Push billable time entries directly into Clio Manage. Automatically syncs accepted time tickets.',
    logo: '⚖️',
    learnMore: 'https://www.clio.com',
    requiresEnv: 'CLIO_CLIENT_ID',
  },
  {
    id: 'mycase',
    name: 'MyCase',
    description: 'Sync time entries with MyCase. Accepted tickets flow directly into your matters.',
    logo: '📋',
    learnMore: 'https://www.mycase.com',
    requiresEnv: 'MYCASE_CLIENT_ID',
  },
];

function IntegrationCard({ provider, integration, onConnect, onDisconnect, apiBase }) {
  const [disconnecting, setDisconnecting] = useState(false);
  const connected = !!integration;
  const hasError = !!integration?.last_error;

  async function handleDisconnect() {
    if (!confirm(`Disconnect ${provider.name}? This won't delete your data in ${provider.name}.`)) return;
    setDisconnecting(true);
    try {
      await onDisconnect(provider.id);
    } finally {
      setDisconnecting(false);
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
          {integration.extra?.firm_name && <div><strong>Firm:</strong> {integration.extra.firm_name}</div>}
          {integration.extra?.account_id && <div><strong>Account ID:</strong> {integration.extra.account_id}</div>}
          {integration.last_sync_at && <div><strong>Last sync:</strong> {formatDate(integration.last_sync_at)}</div>}
          {hasError && <div className="integration-error"><strong>Error:</strong> {integration.last_error}</div>}
        </div>
      )}

      <div className="integration-actions">
        {connected ? (
          <button
            className="btn btn-secondary btn-sm"
            onClick={handleDisconnect}
            disabled={disconnecting}
          >
            {disconnecting ? 'Disconnecting…' : 'Disconnect'}
          </button>
        ) : (
          <a
            href={`${apiBase}/integrations/${provider.id}/connect`}
            className="btn btn-primary btn-sm"
            onClick={() => onConnect(provider.id)}
          >
            Connect {provider.name}
          </a>
        )}
      </div>
    </div>
  );
}

export default function IntegrationSettings() {
  const { data, loading, error, reload } = useFetch('/integrations');
  const [connectingId, setConnectingId] = useState(null);

  // Check for redirect-back query params after OAuth callback
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const integration = params.get('integration');
    const status = params.get('status');
    if (integration && status) {
      if (status === 'connected') {
        reload();
      }
      // Clean up the URL
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

  if (loading) return <Loading label="Loading integrations…" />;
  if (error) return <ErrorState message={error} />;

  const integrations = data?.integrations || [];
  const byProvider = Object.fromEntries(integrations.map((i) => [i.provider, i]));

  const apiBase = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Integrations</h1>
          <p className="page-sub">Connect your practice management software to sync time entries automatically.</p>
        </div>
      </div>

      <div className="integrations-grid">
        {PROVIDERS.map((provider) => (
          <IntegrationCard
            key={provider.id}
            provider={provider}
            integration={byProvider[provider.id] || null}
            onConnect={(id) => setConnectingId(id)}
            onDisconnect={handleDisconnect}
            apiBase={apiBase}
          />
        ))}
      </div>

      <div className="section-note">
        <h4>How it works</h4>
        <ol>
          <li>Connect your practice management system above (OAuth — no passwords stored).</li>
          <li>When you accept a time ticket in the Time Tickets tab, it's automatically pushed to your connected system.</li>
          <li>You can also push individual tickets manually from the Time Tickets page.</li>
        </ol>
        <p>More integrations (Filevine, Smokeball, CosmoLex) coming soon.</p>
      </div>
    </div>
  );
}
