// Time Tickets — review AI-drafted billable time entries from calls.
// Attorneys accept/edit/reject drafts, bulk-approve, and export to CSV.

import { useState } from 'react';
import { useFetch } from '../../lib/useFetch';
import { api } from '../../lib/api';
import { Loading, ErrorState, EmptyState } from '../../components/States';
import { Badge } from '../../components/Badge';
import { formatDate, formatDuration, titleCase } from '../../lib/format';

function EditModal({ ticket, onSave, onClose }) {
  const [form, setForm] = useState({
    client_name: ticket.client_name || '',
    matter_name: ticket.matter_name || '',
    description: ticket.description || '',
    billable_mins: ticket.billable_mins ?? '',
    hourly_rate: ticket.hourly_rate ?? '',
    activity: ticket.activity || 'phone_call',
  });
  const [saving, setSaving] = useState(false);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  async function handleSave() {
    setSaving(true);
    try {
      await onSave({
        ...form,
        billable_mins: form.billable_mins ? Number(form.billable_mins) : null,
        hourly_rate: form.hourly_rate ? Number(form.hourly_rate) : null,
        status: 'accepted',
      });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-box" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Edit Time Entry</h3>
          <button className="btn-icon" onClick={onClose}>✕</button>
        </div>
        <div className="form-grid">
          <label>Client
            <input value={form.client_name} onChange={set('client_name')} placeholder="Client name" />
          </label>
          <label>Matter
            <input value={form.matter_name} onChange={set('matter_name')} placeholder="Matter / topic" />
          </label>
          <label>Activity
            <select value={form.activity} onChange={set('activity')}>
              <option value="phone_call">Phone call</option>
              <option value="consultation">Consultation</option>
              <option value="follow_up">Follow-up</option>
              <option value="voicemail_review">Voicemail review</option>
              <option value="correspondence">Correspondence</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label>Billable minutes
            <input type="number" min="1" value={form.billable_mins} onChange={set('billable_mins')} />
          </label>
          <label>Hourly rate ($)
            <input type="number" min="0" step="0.01" value={form.hourly_rate} onChange={set('hourly_rate')} placeholder="Optional" />
          </label>
          <label className="full">Description
            <textarea rows={3} value={form.description} onChange={set('description')} />
          </label>
        </div>
        <div className="modal-foot">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
            {saving ? 'Saving…' : 'Accept & Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function TimeTickets() {
  const [filter, setFilter] = useState('draft');
  const { data, loading, error, reload } = useFetch(`/admin/time-tickets?status=${filter}`);
  const [editing, setEditing] = useState(null);
  const [busy, setBusy] = useState(false);

  const tickets = data?.tickets || [];
  const draftCount = tickets.filter((t) => t.status === 'draft').length;

  async function accept(id) {
    await api.patch(`/admin/time-tickets/${id}`, { status: 'accepted' });
    reload();
  }

  async function reject(id) {
    await api.delete(`/admin/time-tickets/${id}`);
    reload();
  }

  async function saveEdit(id, patch) {
    await api.patch(`/admin/time-tickets/${id}`, patch);
    reload();
  }

  async function bulkApprove() {
    setBusy(true);
    try {
      const res = await api.post('/admin/time-tickets/bulk-approve');
      alert(`Accepted ${res.accepted} ticket${res.accepted === 1 ? '' : 's'}.`);
      reload();
    } finally {
      setBusy(false);
    }
  }

  function exportCsv() {
    window.location.href = `${api.base}/admin/time-tickets/export.csv`;
  }

  if (loading) return <Loading label="Loading time tickets…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  return (
    <>
      {editing && (
        <EditModal
          ticket={editing}
          onSave={(patch) => saveEdit(editing.id, patch)}
          onClose={() => setEditing(null)}
        />
      )}

      <div className="page-head">
        <div>
          <h1>Time Tickets</h1>
          <p>AI-drafted billable entries from calls and voicemails. Review, edit, and export.</p>
        </div>
        <div className="page-head-actions">
          {filter === 'draft' && draftCount > 0 && (
            <button className="btn btn-primary" onClick={bulkApprove} disabled={busy}>
              {busy ? 'Approving…' : `Approve all (${draftCount})`}
            </button>
          )}
          <button className="btn btn-secondary" onClick={exportCsv}>
            Export CSV
          </button>
        </div>
      </div>

      <div className="filter-tabs">
        {['draft', 'accepted', 'rejected'].map((s) => (
          <button
            key={s}
            className={`filter-tab${filter === s ? ' active' : ''}`}
            onClick={() => setFilter(s)}
          >
            {titleCase(s)}
          </button>
        ))}
      </div>

      <div className="card">
        {tickets.length === 0 ? (
          <EmptyState
            title={`No ${filter} tickets`}
            message={
              filter === 'draft'
                ? 'New tickets appear here automatically after each AI-handled call or voicemail.'
                : `No ${filter} tickets yet.`
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Client</th>
                  <th>Matter</th>
                  <th>Activity</th>
                  <th>Description</th>
                  <th>Duration</th>
                  <th>Billable</th>
                  <th>Status</th>
                  {filter === 'draft' && <th />}
                </tr>
              </thead>
              <tbody>
                {tickets.map((t) => (
                  <tr key={t.id}>
                    <td className="muted">{formatDate(t.created_at)}</td>
                    <td>{t.client_name || <span className="muted">—</span>}</td>
                    <td>{t.matter_name || <span className="muted">—</span>}</td>
                    <td>{titleCase(t.activity || '')}</td>
                    <td style={{ maxWidth: 280 }}><span className="truncate">{t.description}</span></td>
                    <td>{formatDuration(t.duration_sec)}</td>
                    <td>{t.billable_mins ? `${t.billable_mins} min` : '—'}</td>
                    <td><Badge value={t.status} /></td>
                    {filter === 'draft' && (
                      <td>
                        <div className="row-actions">
                          <button className="btn btn-sm btn-primary" onClick={() => accept(t.id)}>Accept</button>
                          <button className="btn btn-sm btn-secondary" onClick={() => setEditing(t)}>Edit</button>
                          <button className="btn btn-sm btn-danger" onClick={() => reject(t.id)}>Reject</button>
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
