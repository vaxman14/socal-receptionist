// Outbound Leads — manage the list of prospects to call, trigger AI calls,
// track call status. Phone-based outreach campaign management.

import { useState } from 'react';
import { useFetch } from '../../lib/useFetch';
import { api } from '../../lib/api';
import { Loading, ErrorState, EmptyState } from '../../components/States';
import { Badge } from '../../components/Badge';
import { formatDate } from '../../lib/format';

const STATUS_COLOR = {
  pending: 'gray',
  calling: 'blue',
  answered: 'green',
  voicemail: 'yellow',
  no_answer: 'yellow',
  lead_captured: 'green',
  not_interested: 'red',
  dnc: 'red',
};

const STATUS_LABEL = {
  pending: 'Pending',
  calling: 'Calling…',
  answered: 'Answered',
  voicemail: 'Voicemail',
  no_answer: 'No Answer',
  lead_captured: 'Lead Captured',
  not_interested: 'Not Interested',
  dnc: 'DNC',
};

function AddLeadModal({ onAdd, onClose }) {
  const [form, setForm] = useState({ name: '', phone: '', businessType: '', reason: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.phone) return setError('Phone number is required');
    setSaving(true);
    setError('');
    try {
      const data = await api.post('/admin/outbound-leads', form);
      onAdd(data.lead);
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to add lead');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Add Outbound Lead</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleSubmit} className="modal-body">
          {error && <div className="alert alert-error">{error}</div>}
          <div className="field">
            <label>Phone Number *</label>
            <input type="tel" value={form.phone} onChange={set('phone')} placeholder="+1 (555) 000-0000" required />
          </div>
          <div className="field">
            <label>Name</label>
            <input type="text" value={form.name} onChange={set('name')} placeholder="John Smith" />
          </div>
          <div className="field">
            <label>Business Type</label>
            <input type="text" value={form.businessType} onChange={set('businessType')} placeholder="e.g. dental practice, law firm" />
          </div>
          <div className="field">
            <label>Reason / Context</label>
            <input type="text" value={form.reason} onChange={set('reason')} placeholder="e.g. Filled out our contact form" />
          </div>
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Adding…' : 'Add Lead'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function BulkImportModal({ onImport, onClose }) {
  const [csv, setCsv] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function handleImport(e) {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const lines = csv.trim().split('\n').filter(Boolean);
      // Support CSV: phone,name,businessType,reason (first line may be header)
      const isHeader = lines[0].toLowerCase().includes('phone');
      const rows = (isHeader ? lines.slice(1) : lines).map((line) => {
        const [phone, name, businessType, reason] = line.split(',').map((s) => s.trim().replace(/^"|"$/g, ''));
        return { phone, name, businessType, reason };
      }).filter((r) => r.phone);

      if (!rows.length) throw new Error('No valid phone numbers found');

      const data = await api.post('/admin/outbound-leads/bulk', { leads: rows });
      onImport(data.created);
      onClose();
    } catch (err) {
      setError(err.message || 'Import failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal-lg" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h3>Bulk Import Leads</h3>
          <button className="modal-close" onClick={onClose}>✕</button>
        </div>
        <form onSubmit={handleImport} className="modal-body">
          {error && <div className="alert alert-error">{error}</div>}
          <p className="help-text">Paste CSV data: <code>phone, name, businessType, reason</code> (one per line)</p>
          <textarea
            className="code-input"
            rows={10}
            value={csv}
            onChange={(e) => setCsv(e.target.value)}
            placeholder={`+19515551234,John Smith,dental practice,Filled out contact form\n+19515559876,Jane Doe,law firm,Requested callback`}
          />
          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Importing…' : 'Import'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function OutboundLeads() {
  const { data, loading, error, reload } = useFetch('/admin/outbound-leads');
  const [showAdd, setShowAdd] = useState(false);
  const [showBulk, setShowBulk] = useState(false);
  const [calling, setCalling] = useState(new Set());
  const [statusFilter, setStatusFilter] = useState('all');

  const leads = data?.leads || [];
  const filtered = statusFilter === 'all' ? leads : leads.filter((l) => l.status === statusFilter);

  async function triggerCall(lead) {
    if (calling.has(lead.id)) return;
    setCalling((s) => new Set([...s, lead.id]));
    try {
      await api.post(`/admin/outbound-leads/${lead.id}/call`, {});
      reload();
    } catch (err) {
      alert(`Call failed: ${err.message}`);
    } finally {
      setCalling((s) => { const n = new Set(s); n.delete(lead.id); return n; });
    }
  }

  async function updateStatus(lead, status) {
    try {
      await api.patch(`/admin/outbound-leads/${lead.id}`, { status });
      reload();
    } catch (err) {
      alert(`Update failed: ${err.message}`);
    }
  }

  async function deleteLead(lead) {
    if (!confirm(`Delete lead for ${lead.phone}?`)) return;
    try {
      await api.delete(`/admin/outbound-leads/${lead.id}`);
      reload();
    } catch (err) {
      alert(`Delete failed: ${err.message}`);
    }
  }

  if (loading) return <Loading label="Loading leads…" />;
  if (error) return <ErrorState message={error} />;

  const counts = leads.reduce((acc, l) => { acc[l.status] = (acc[l.status] || 0) + 1; return acc; }, {});
  const callablePending = leads.filter((l) => l.status === 'pending').length;

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Outbound Leads</h1>
          <p className="page-sub">{leads.length} leads — {counts.lead_captured || 0} captured, {callablePending} pending</p>
        </div>
        <div className="btn-group">
          <button className="btn btn-secondary" onClick={() => setShowBulk(true)}>Bulk Import</button>
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>+ Add Lead</button>
        </div>
      </div>

      <div className="filter-bar">
        {['all', 'pending', 'calling', 'no_answer', 'answered', 'lead_captured', 'not_interested', 'dnc'].map((s) => (
          <button
            key={s}
            className={`filter-chip ${statusFilter === s ? 'active' : ''}`}
            onClick={() => setStatusFilter(s)}
          >
            {s === 'all' ? `All (${leads.length})` : `${STATUS_LABEL[s]} (${counts[s] || 0})`}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          title={statusFilter === 'all' ? 'No outbound leads yet' : `No ${STATUS_LABEL[statusFilter] || statusFilter} leads`}
          message={statusFilter === 'all' ? 'Add a lead or bulk import a list to start calling.' : undefined}
          action={statusFilter === 'all' ? { label: '+ Add Lead', onClick: () => setShowAdd(true) } : undefined}
        />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Contact</th>
                <th>Business</th>
                <th>Status</th>
                <th>Attempts</th>
                <th>Last Called</th>
                <th>Notes</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((lead) => (
                <tr key={lead.id}>
                  <td>
                    <div className="cell-primary">{lead.name || '—'}</div>
                    <div className="cell-secondary">{lead.phone}</div>
                  </td>
                  <td>
                    <div>{lead.business_type || '—'}</div>
                    {lead.reason && <div className="cell-secondary">{lead.reason}</div>}
                  </td>
                  <td><Badge color={STATUS_COLOR[lead.status]}>{STATUS_LABEL[lead.status]}</Badge></td>
                  <td>{lead.call_attempts || 0}</td>
                  <td>{lead.last_called_at ? formatDate(lead.last_called_at) : '—'}</td>
                  <td className="notes-cell">{lead.notes ? <span title={lead.notes}>{lead.notes.slice(0, 60)}{lead.notes.length > 60 ? '…' : ''}</span> : '—'}</td>
                  <td>
                    <div className="row-actions">
                      {['pending', 'no_answer', 'voicemail'].includes(lead.status) && (
                        <button
                          className="btn btn-sm btn-primary"
                          onClick={() => triggerCall(lead)}
                          disabled={calling.has(lead.id)}
                        >
                          {calling.has(lead.id) ? 'Calling…' : 'Call Now'}
                        </button>
                      )}
                      {lead.status !== 'dnc' && (
                        <button className="btn btn-sm btn-ghost" onClick={() => updateStatus(lead, 'dnc')} title="Mark DNC">
                          DNC
                        </button>
                      )}
                      <button className="btn btn-sm btn-ghost btn-danger" onClick={() => deleteLead(lead)} title="Delete">
                        ✕
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showAdd && (
        <AddLeadModal
          onAdd={(lead) => reload()}
          onClose={() => setShowAdd(false)}
        />
      )}
      {showBulk && (
        <BulkImportModal
          onImport={() => reload()}
          onClose={() => setShowBulk(false)}
        />
      )}
    </div>
  );
}
