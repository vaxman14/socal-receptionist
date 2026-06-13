// Client Marketing — social media handles + (upcoming) direct posting.
// Handles are saved to tenants.social_handles via PATCH /admin/tenant.

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useFetch } from '../../lib/useFetch';
import { Loading, ErrorState } from '../../components/States';

// Platform key must match the server-side ALLOWED_PLATFORMS whitelist.
const PLATFORMS = [
  { key: 'facebook',        label: 'Facebook',        placeholder: 'facebook.com/yourbusiness' },
  { key: 'instagram',       label: 'Instagram',       placeholder: '@yourbusiness' },
  { key: 'linkedin',        label: 'LinkedIn',        placeholder: 'linkedin.com/company/yourbusiness' },
  { key: 'twitter',         label: 'X (Twitter)',     placeholder: '@yourbusiness' },
  { key: 'tiktok',          label: 'TikTok',          placeholder: '@yourbusiness' },
  { key: 'youtube',         label: 'YouTube',         placeholder: 'youtube.com/@yourbusiness' },
  { key: 'google_business', label: 'Google Business', placeholder: 'Business Profile name or link' },
];

export default function Marketing() {
  const { data, loading, error, reload } = useFetch('/admin/me');
  const [handles, setHandles] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data?.tenant) {
      const src = data.tenant.social_handles || {};
      const next = {};
      for (const p of PLATFORMS) next[p.key] = src[p.key] || '';
      setHandles(next);
    }
  }, [data]);

  if (loading) return <Loading label="Loading marketing…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!handles) return <Loading />;

  const set = (key) => (e) => {
    const value = e.target.value;
    setHandles((h) => ({ ...h, [key]: value }));
    setSaved(false);
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaveError(null);
    setSaved(false);
    setBusy(true);
    try {
      // Send all platforms; blank values clear that platform server-side.
      await api.patch('/admin/tenant', { social_handles: handles });
      setSaved(true);
      reload();
    } catch (err) {
      setSaveError(err.message || 'Could not save your social handles.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Marketing</h1>
        <p>Connect your social media and (soon) post to all your channels from here.</p>
      </div>

      {saveError && <div className="alert alert-error">{saveError}</div>}
      {saved && <div className="alert alert-success">Social handles saved.</div>}

      <form onSubmit={submit} className="stack">
        <div className="card card-pad">
          <div className="section-title">Social media profiles</div>
          <p className="muted" style={{ fontSize: '0.86rem', marginBottom: 12 }}>
            Add your handles or profile links for each platform you use. Leave any you
            don't use blank.
          </p>

          {PLATFORMS.map((p) => (
            <label className="field" key={p.key}>
              <span className="label">{p.label}</span>
              <input
                type="text"
                value={handles[p.key]}
                onChange={set(p.key)}
                placeholder={p.placeholder}
              />
            </label>
          ))}

          <div className="row-gap" style={{ marginTop: 4 }}>
            <button className="btn btn-primary" disabled={busy} type="submit">
              {busy ? 'Saving…' : 'Save handles'}
            </button>
            {saved && <span className="muted" style={{ fontSize: '0.86rem' }}>All changes saved.</span>}
          </div>
        </div>

        <div className="card card-pad">
          <div className="section-title">Post to your socials</div>
          <p className="muted" style={{ fontSize: '0.86rem', marginBottom: 12 }}>
            Soon you'll be able to write a post once and publish it to all your connected
            channels right from this page — promotions, updates, and announcements.
          </p>
          <div
            style={{
              border: '1px dashed var(--border)', borderRadius: 10,
              padding: '20px', textAlign: 'center', background: 'var(--surface-alt, #f9f9fb)',
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Direct posting — coming soon</div>
            <p className="muted" style={{ fontSize: '0.84rem', margin: 0 }}>
              Add your handles above to get ready. We'll turn on one-click cross-posting here.
            </p>
          </div>
        </div>
      </form>
    </>
  );
}
