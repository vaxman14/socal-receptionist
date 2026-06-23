// Client Marketing — Google Business Profile (reviews) + social handles +
// (upcoming) direct posting. Handles are saved to tenants.social_handles via
// PATCH /admin/tenant. Review requests go out via POST /admin/marketing/review-request.

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useFetch } from '../../lib/useFetch';
import { Loading, ErrorState } from '../../components/States';

// Social platforms (Google Business is handled separately, in its own card).
// Keys must match the server-side ALLOWED_PLATFORMS whitelist.
const SOCIAL_PLATFORMS = [
  { key: 'facebook',  label: 'Facebook',    placeholder: 'facebook.com/yourbusiness' },
  { key: 'instagram', label: 'Instagram',   placeholder: '@yourbusiness' },
  { key: 'linkedin',  label: 'LinkedIn',    placeholder: 'linkedin.com/company/yourbusiness' },
  { key: 'twitter',   label: 'X (Twitter)', placeholder: '@yourbusiness' },
  { key: 'tiktok',    label: 'TikTok',      placeholder: '@yourbusiness' },
  { key: 'youtube',   label: 'YouTube',     placeholder: 'youtube.com/@yourbusiness' },
];

const ALL_KEYS = [...SOCIAL_PLATFORMS.map((p) => p.key), 'google_business'];

export default function Marketing() {
  const { data, loading, error, reload } = useFetch('/admin/me');
  const [handles, setHandles] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved] = useState(false);

  // Review-request tool state.
  const [reviewChannel, setReviewChannel] = useState('sms');
  const [reviewTo, setReviewTo] = useState('');
  const [reviewBusy, setReviewBusy] = useState(false);
  const [reviewMsg, setReviewMsg] = useState(null);
  const [copied, setCopied] = useState(false);
  const [brand, setBrand] = useState(null);
  const [brandBusy, setBrandBusy] = useState(false);
  const [brandSaved, setBrandSaved] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const [logoErr, setLogoErr] = useState(null);

  useEffect(() => {
    if (data?.tenant) {
      const src = data.tenant.social_handles || {};
      const next = {};
      for (const key of ALL_KEYS) next[key] = src[key] || '';
      setHandles(next);
      setBrand({
        email_logo_url: data.tenant.email_logo_url || '',
        email_brand_color: data.tenant.email_brand_color || '',
        email_from_name: data.tenant.email_from_name || '',
      });
    }
  }, [data]);

  if (loading) return <Loading label="Loading marketing…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!handles || !brand) return <Loading />;

  // The persisted review link drives the request/share tools (the backend reads
  // the saved value, so unsaved edits don't count until you hit Save).
  const savedReviewLink = data?.tenant?.social_handles?.google_business || '';
  const businessName = data?.tenant?.business_name || 'us';
  const postText = `Love working with ${businessName}? We'd really appreciate a quick Google review! ${savedReviewLink}`;

  const set = (key) => (e) => {
    const value = e.target.value;
    setHandles((h) => ({ ...h, [key]: value }));
    setSaved(false);
  };

  // ── Email branding ──
  const setBrandField = (key) => (e) => {
    setBrand((b) => ({ ...b, [key]: e.target.value }));
    setBrandSaved(false);
  };

  const LOGO_MAX_KB = 500, LOGO_MAX_W = 1000, LOGO_MAX_H = 400;
  const uploadLogo = async (file) => {
    setLogoErr(null);
    if (!file) return;
    if (!/^image\/(png|jpeg)$/.test(file.type)) { setLogoErr('Use a PNG or JPG image.'); return; }
    if (file.size > LOGO_MAX_KB * 1024) { setLogoErr(`Logo must be under ${LOGO_MAX_KB} KB (yours is ${Math.round(file.size / 1024)} KB).`); return; }
    const dataUrl = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = () => reject(new Error('Could not read the file.'));
      r.readAsDataURL(file);
    }).catch((err) => { setLogoErr(err.message); return null; });
    if (!dataUrl) return;
    const dim = await new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
    if (dim && (dim.w > LOGO_MAX_W || dim.h > LOGO_MAX_H)) {
      setLogoErr(`Logo is ${dim.w}×${dim.h}px — max ${LOGO_MAX_W}×${LOGO_MAX_H}px. Use a smaller image.`);
      return;
    }
    setLogoBusy(true);
    try {
      const res = await api.post('/admin/tenant/logo', { dataUrl });
      setBrand((b) => ({ ...b, email_logo_url: res.url }));
      setBrandSaved(false);
    } catch (err) {
      setLogoErr(err.message || 'Upload failed.');
    } finally {
      setLogoBusy(false);
    }
  };

  const saveBranding = async () => {
    setBrandBusy(true);
    setBrandSaved(false);
    try {
      await api.patch('/admin/tenant', {
        email_logo_url: brand.email_logo_url,
        email_brand_color: brand.email_brand_color,
        email_from_name: brand.email_from_name,
      });
      setBrandSaved(true);
      reload();
    } catch (err) {
      setLogoErr(err.message || 'Could not save branding.');
    } finally {
      setBrandBusy(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaveError(null);
    setSaved(false);
    setBusy(true);
    try {
      // Send all keys; blank values clear that platform server-side.
      await api.patch('/admin/tenant', { social_handles: handles });
      setSaved(true);
      reload();
    } catch (err) {
      setSaveError(err.message || 'Could not save your marketing settings.');
    } finally {
      setBusy(false);
    }
  };

  const sendReview = async () => {
    setReviewMsg(null);
    if (!reviewTo.trim()) {
      setReviewMsg({ ok: false, text: `Enter a ${reviewChannel === 'sms' ? 'phone number' : 'email address'}.` });
      return;
    }
    setReviewBusy(true);
    try {
      await api.post('/admin/marketing/review-request', { channel: reviewChannel, to: reviewTo.trim() });
      setReviewMsg({ ok: true, text: `Review request sent by ${reviewChannel === 'sms' ? 'text' : 'email'}.` });
      setReviewTo('');
    } catch (err) {
      setReviewMsg({ ok: false, text: err.message || 'Could not send the review request.' });
    } finally {
      setReviewBusy(false);
    }
  };

  const copyPost = async () => {
    try {
      await navigator.clipboard.writeText(postText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setReviewMsg({ ok: false, text: 'Could not copy. Select and copy the text manually.' });
    }
  };

  const shareUrls = {
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(savedReviewLink)}`,
    twitter: `https://twitter.com/intent/tweet?text=${encodeURIComponent(postText)}`,
    linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(savedReviewLink)}`,
  };

  return (
    <>
      <div className="page-head">
        <h1>Marketing</h1>
        <p>Collect Google reviews and connect your social media.</p>
      </div>

      {saveError && <div className="alert alert-error">{saveError}</div>}
      {saved && <div className="alert alert-success">Marketing settings saved.</div>}

      <div className="stack">
        {/* ── Email branding (white-label) ── */}
        <div className="card card-pad">
          <div className="section-title">Email Branding</div>
          <p className="muted" style={{ fontSize: '0.86rem', marginBottom: 8 }}>
            White-label the emails your customers receive — booking confirmations, reminders, and review requests. Your logo, color, and sender name.
          </p>
          {brandSaved && <div className="alert alert-success" style={{ marginBottom: 10 }}>Branding saved.</div>}

          <div className="field">
            <span className="label">Logo</span>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 }}>
              {brand.email_logo_url ? (
                <span style={{ display: 'inline-block', padding: '10px 16px', borderRadius: 8, background: brand.email_brand_color || '#f47c20' }}>
                  <img src={brand.email_logo_url} alt="logo preview" style={{ height: 30, display: 'block' }} />
                </span>
              ) : null}
              <label className="btn btn-secondary" style={{ cursor: logoBusy ? 'default' : 'pointer', margin: 0 }}>
                {logoBusy ? 'Uploading…' : (brand.email_logo_url ? 'Replace logo' : 'Upload logo')}
                <input
                  type="file"
                  accept="image/png,image/jpeg"
                  style={{ display: 'none' }}
                  disabled={logoBusy}
                  onChange={(e) => { uploadLogo(e.target.files?.[0]); e.target.value = ''; }}
                />
              </label>
              {brand.email_logo_url ? (
                <button
                  type="button"
                  onClick={() => setBrand((b) => ({ ...b, email_logo_url: '' }))}
                  style={{ background: 'none', border: 'none', color: '#6b7280', cursor: 'pointer', textDecoration: 'underline', fontSize: '0.85rem' }}
                >
                  Remove
                </button>
              ) : null}
            </div>
            {logoErr
              ? <span className="hint" style={{ color: '#b91c1c' }}>{logoErr}</span>
              : <span className="hint">PNG or JPG, max {LOGO_MAX_KB} KB and {LOGO_MAX_W}×{LOGO_MAX_H}px. A white or light logo looks best on the colored header. Leave blank to use your business name as text.</span>}
          </div>

          <label className="field">
            <span className="label">Brand color</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input
                type="color"
                value={brand.email_brand_color || '#f47c20'}
                onChange={setBrandField('email_brand_color')}
                style={{ width: 48, height: 38, padding: 2, border: '1px solid #ddd', borderRadius: 8, cursor: 'pointer' }}
              />
              <input
                type="text"
                value={brand.email_brand_color || ''}
                onChange={setBrandField('email_brand_color')}
                placeholder="#f47c20"
                style={{ flex: 1 }}
              />
            </div>
            <span className="hint">The email header background color.</span>
          </label>

          <label className="field">
            <span className="label">Sender name</span>
            <input
              type="text"
              value={brand.email_from_name || ''}
              onChange={setBrandField('email_from_name')}
              placeholder="e.g. Temecula Valley Family Law"
            />
            <span className="hint">Optional display name shown as the email sender.</span>
          </label>

          <button type="button" className="btn btn-primary" onClick={saveBranding} disabled={brandBusy}>
            {brandBusy ? 'Saving…' : 'Save branding'}
          </button>
        </div>

        {/* ── Google Business Profile (reviews) ── */}
        <div className="card card-pad">
          <div className="section-title">Google Business Profile</div>
          <p className="muted" style={{ fontSize: '0.86rem', marginBottom: 12 }}>
            Paste your Google review link below, then send it to happy customers to
            collect more 5-star reviews. Find it in your Business Profile under
            "Ask for reviews" — it looks like <code>https://g.page/r/…/review</code>.
          </p>

          <form onSubmit={submit}>
            <label className="field">
              <span className="label">Google review link</span>
              <input
                type="text"
                value={handles.google_business}
                onChange={set('google_business')}
                placeholder="https://g.page/r/your-business/review"
              />
            </label>
            <div className="row-gap" style={{ marginTop: 4 }}>
              <button className="btn btn-primary" disabled={busy} type="submit">
                {busy ? 'Saving…' : 'Save link'}
              </button>
            </div>
          </form>

          {/* Request a review */}
          <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Request a review</div>
            <p className="muted" style={{ fontSize: '0.84rem', marginBottom: 12 }}>
              Send a customer your review link by text or email.
            </p>

            {!savedReviewLink && (
              <div className="alert alert-error" style={{ marginBottom: 12 }}>
                Add and save your Google review link above first.
              </div>
            )}
            {reviewMsg && (
              <div className={`alert ${reviewMsg.ok ? 'alert-success' : 'alert-error'}`} style={{ marginBottom: 12 }}>
                {reviewMsg.text}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
              {['sms', 'email'].map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`btn btn-sm ${reviewChannel === c ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => { setReviewChannel(c); setReviewMsg(null); }}
                >
                  {c === 'sms' ? 'Text' : 'Email'}
                </button>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <input
                type={reviewChannel === 'sms' ? 'tel' : 'email'}
                value={reviewTo}
                onChange={(e) => setReviewTo(e.target.value)}
                placeholder={reviewChannel === 'sms' ? '+1 951 555 0142' : 'customer@email.com'}
                style={{ flex: '1 1 220px' }}
                disabled={!savedReviewLink}
              />
              <button
                type="button"
                className="btn btn-primary"
                onClick={sendReview}
                disabled={reviewBusy || !savedReviewLink}
              >
                {reviewBusy ? 'Sending…' : 'Send review request'}
              </button>
            </div>
            {reviewChannel === 'sms' && (
              <p className="muted" style={{ fontSize: '0.78rem', marginTop: 8 }}>
                Only text customers who've agreed to hear from you. Standard messaging rates apply.
              </p>
            )}
          </div>

          {/* Share to socials */}
          {savedReviewLink && (
            <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>Share to your socials</div>
              <p className="muted" style={{ fontSize: '0.84rem', marginBottom: 12 }}>
                Post your review link so followers can leave a review with one tap.
              </p>
              <div style={{
                background: 'var(--surface-alt, #f9f9fb)', border: '1px solid var(--border)',
                borderRadius: 8, padding: '10px 12px', fontSize: '0.86rem', marginBottom: 10,
              }}>
                {postText}
              </div>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" className="btn btn-sm btn-secondary" onClick={copyPost}>
                  {copied ? 'Copied ✓' : 'Copy text'}
                </button>
                <a className="btn btn-sm btn-secondary" href={shareUrls.facebook} target="_blank" rel="noopener noreferrer">Facebook</a>
                <a className="btn btn-sm btn-secondary" href={shareUrls.twitter} target="_blank" rel="noopener noreferrer">X</a>
                <a className="btn btn-sm btn-secondary" href={shareUrls.linkedin} target="_blank" rel="noopener noreferrer">LinkedIn</a>
              </div>
            </div>
          )}
        </div>

        {/* ── Social handles ── */}
        <form onSubmit={submit}>
          <div className="card card-pad">
            <div className="section-title">Social media profiles</div>
            <p className="muted" style={{ fontSize: '0.86rem', marginBottom: 12 }}>
              Add your handles or profile links for each platform you use. Leave any you
              don't use blank.
            </p>

            {SOCIAL_PLATFORMS.map((p) => (
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
        </form>

        {/* ── Direct posting (coming soon) ── */}
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
      </div>
    </>
  );
}
