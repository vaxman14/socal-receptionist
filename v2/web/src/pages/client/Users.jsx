// Team / Users — per-tenant members. Owners can invite, change roles, and
// remove. Admins can view. Two roles: owner (billing + close account) | admin.

import { useState } from 'react';
import { useFetch } from '../../lib/useFetch';
import { api } from '../../lib/api';
import { Loading, ErrorState } from '../../components/States';
import { Badge } from '../../components/Badge';

export default function Users() {
  const { data, loading, error, reload } = useFetch('/admin/users');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('admin');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);
  const [inviteLink, setInviteLink] = useState(null);

  if (loading) return <Loading label="Loading team…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  const users = data?.users || [];
  const isOwner = data?.myRole === 'owner';

  async function invite(e) {
    e.preventDefault();
    setBusy(true); setErr(null); setMsg(null); setInviteLink(null);
    try {
      const r = await api.post('/admin/users', { email: email.trim(), role });
      setMsg(`Invite sent to ${email.trim()}.`);
      setInviteLink(r.invite_link || null);
      setEmail('');
      reload();
    } catch (e2) {
      setErr(e2.message || 'Invite failed');
    } finally {
      setBusy(false);
    }
  }

  async function changeRole(u, newRole) {
    setErr(null);
    try { await api.patch(`/admin/users/${u.id}`, { role: newRole }); reload(); }
    catch (e2) { setErr(e2.message || 'Could not change role'); }
  }

  async function remove(u) {
    if (!window.confirm(`Remove ${u.full_name || u.email}?`)) return;
    setErr(null);
    try { await api.delete(`/admin/users/${u.id}`); reload(); }
    catch (e2) { setErr(e2.message || 'Could not remove member'); }
  }

  return (
    <>
      <div className="page-head">
        <h1>Users</h1>
        <p className="muted">Your team. Owners manage billing and the account; admins can do everything else.</p>
      </div>

      <div className="stack">
        {err && <div className="card card-pad" style={{ color: 'var(--red, #c0392b)' }}>{err}</div>}
        {msg && (
          <div className="card card-pad" style={{ color: 'var(--green, #1f8a4c)' }}>
            {msg}
            {inviteLink && (
              <p className="muted" style={{ marginTop: 6, wordBreak: 'break-all' }}>
                Invite link (if the email doesn’t arrive, share this): <span className="mono">{inviteLink}</span>
              </p>
            )}
          </div>
        )}

        {isOwner && (
          <div className="card card-pad">
            <div className="section-title">Invite a user</div>
            <form onSubmit={invite} className="row-gap" style={{ flexWrap: 'wrap', gap: 10, alignItems: 'flex-end' }}>
              <div style={{ flex: '1 1 220px' }}>
                <label className="muted" style={{ display: 'block', fontSize: '0.8rem', marginBottom: 4 }}>Email</label>
                <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
                  placeholder="teammate@email.com" disabled={busy} style={{ width: '100%' }} />
              </div>
              <div>
                <label className="muted" style={{ display: 'block', fontSize: '0.8rem', marginBottom: 4 }}>Role</label>
                <select value={role} onChange={(e) => setRole(e.target.value)} disabled={busy}>
                  <option value="admin">Admin</option>
                  <option value="owner">Owner</option>
                </select>
              </div>
              <button className="btn btn-primary" disabled={busy} type="submit">{busy ? 'Sending…' : 'Send invite'}</button>
            </form>
          </div>
        )}

        <div className="card">
          <div className="card-head"><h2>Team members</h2></div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th>{isOwner && <th></th>}</tr>
              </thead>
              <tbody>
                {users.map((u) => (
                  <tr key={u.id}>
                    <td>{u.full_name || <span className="muted">—</span>}</td>
                    <td>{u.email}</td>
                    <td>
                      {isOwner ? (
                        <select value={u.role} onChange={(e) => changeRole(u, e.target.value)}>
                          <option value="admin">Admin</option>
                          <option value="owner">Owner</option>
                        </select>
                      ) : (
                        u.role
                      )}
                    </td>
                    <td><Badge value={u.status} /></td>
                    {isOwner && (
                      <td style={{ textAlign: 'right' }}>
                        <button className="btn btn-danger btn-sm" onClick={() => remove(u)}>Remove</button>
                      </td>
                    )}
                  </tr>
                ))}
                {users.length === 0 && (
                  <tr><td colSpan={isOwner ? 5 : 4} className="muted">No team members yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}
