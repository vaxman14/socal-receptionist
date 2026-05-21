// Owner Documents — editable policy pages + versioned e-sign contracts.
//
// Two surfaces, both backed by /admin/owner:
//   * Legal documents — privacy / terms / etc. pages, edited in place (PUT).
//   * Contracts       — the Service Agreement clients e-sign. New versions are
//                       uploaded, then published to become the live one.

import { useState } from 'react';
import { api } from '../../lib/api';
import { useFetch } from '../../lib/useFetch';
import { Loading, ErrorState, EmptyState } from '../../components/States';
import { Markdown } from '../../components/Markdown';
import { formatDate, titleCase } from '../../lib/format';

export default function Documents() {
  return (
    <>
      <div className="page-head">
        <h1>Documents</h1>
        <p>Edit public policy pages and manage the e-sign service agreement.</p>
      </div>

      <div className="stack">
        <LegalDocuments />
        <Contracts />
      </div>
    </>
  );
}

// --- Legal / policy pages ---------------------------------------------------

function LegalDocuments() {
  const { data, loading, error, reload } = useFetch('/admin/owner/legal-documents');
  const [editing, setEditing] = useState(null); // slug currently open in the editor

  if (loading) {
    return (
      <div className="card card-pad">
        <Loading label="Loading policy pages…" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="card card-pad">
        <ErrorState message={error} onRetry={reload} />
      </div>
    );
  }

  const slugs = data?.editable_slugs || [];
  const missing = new Set(data?.missing_slugs || []);
  const bySlug = {};
  for (const d of data?.documents || []) bySlug[d.slug] = d;

  return (
    <div className="card">
      <div className="card-head">
        <h2>Policy pages</h2>
        <span className="muted" style={{ fontSize: '0.84rem' }}>
          {slugs.length - missing.size} of {slugs.length} published
        </span>
      </div>

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Page</th>
              <th>Title</th>
              <th>Status</th>
              <th>Last updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {slugs.map((slug) => {
              const doc = bySlug[slug];
              const isMissing = missing.has(slug);
              return (
                <tr key={slug}>
                  <td style={{ fontWeight: 600 }}>{titleCase(slug)}</td>
                  <td>{doc?.title || <span className="muted">—</span>}</td>
                  <td>
                    <span className={`badge badge-${isMissing ? 'warn' : 'green'}`}>
                      {isMissing ? 'Not created' : 'Published'}
                    </span>
                  </td>
                  <td className="muted">{doc ? formatDate(doc.updated_at) : '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => setEditing(editing === slug ? null : slug)}
                    >
                      {editing === slug ? 'Close' : isMissing ? 'Create' : 'Edit'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing && (
        <DocEditor
          key={editing}
          slug={editing}
          doc={bySlug[editing] || null}
          onClose={() => setEditing(null)}
          onSaved={reload}
        />
      )}
    </div>
  );
}

function DocEditor({ slug, doc, onClose, onSaved }) {
  const [title, setTitle] = useState(doc?.title || '');
  const [body, setBody] = useState(doc?.body || '');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    setSaveError(null);
    setSaved(false);

    if (!title.trim()) {
      setSaveError('A title is required.');
      return;
    }
    if (!body.trim()) {
      setSaveError('Page content cannot be empty.');
      return;
    }

    setBusy(true);
    try {
      await api.put(`/admin/owner/legal-documents/${slug}`, {
        title: title.trim(),
        body,
      });
      setSaved(true);
      onSaved();
    } catch (err) {
      setSaveError(err.message || 'Could not save the page.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="card-pad" style={{ borderTop: '1px solid var(--border)' }}>
      <div className="section-title">Editing — {titleCase(slug)}</div>

      {saveError && <div className="alert alert-error">{saveError}</div>}
      {saved && <div className="alert alert-success">Page saved.</div>}

      <label className="field">
        <span className="label">Title</span>
        <input
          type="text"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value);
            setSaved(false);
          }}
          placeholder={`${titleCase(slug)} page title`}
        />
      </label>

      <label className="field">
        <span className="label">Content</span>
        <textarea
          className="code"
          rows={12}
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            setSaved(false);
          }}
          placeholder="Markdown — headings, lists, links, **bold**…"
        />
        <span className="hint">
          Markdown is rendered for the public page. The preview below shows the result.
        </span>
      </label>

      {body.trim() && (
        <>
          <div className="section-title">Preview</div>
          <Markdown source={body} />
        </>
      )}

      <div className="row-gap" style={{ marginTop: 16 }}>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save page'}
        </button>
        <button className="btn btn-secondary" type="button" onClick={onClose}>
          Done
        </button>
      </div>
    </form>
  );
}

// --- E-sign contracts -------------------------------------------------------

function Contracts() {
  const { data, loading, error, reload } = useFetch('/admin/owner/contracts');
  const [showUpload, setShowUpload] = useState(false);
  const [publishingId, setPublishingId] = useState(null);
  const [actionError, setActionError] = useState(null);

  if (loading) {
    return (
      <div className="card card-pad">
        <Loading label="Loading contracts…" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="card card-pad">
        <ErrorState message={error} onRetry={reload} />
      </div>
    );
  }

  const contracts = data?.contracts || [];
  const current = contracts.find((c) => c.is_current) || null;

  const publish = async (id) => {
    setActionError(null);
    setPublishingId(id);
    try {
      await api.post(`/admin/owner/contracts/${id}/publish`);
      reload();
    } catch (err) {
      setActionError(err.message || 'Could not publish this version.');
    } finally {
      setPublishingId(null);
    }
  };

  return (
    <div className="card">
      <div className="card-head">
        <h2>E-sign service agreement</h2>
        <button
          className="btn btn-primary btn-sm"
          onClick={() => setShowUpload((v) => !v)}
        >
          {showUpload ? 'Cancel' : 'Upload new version'}
        </button>
      </div>

      <div className="card-pad" style={{ borderBottom: '1px solid var(--border)' }}>
        {current ? (
          <div className="alert alert-success" style={{ marginBottom: 0 }}>
            Live version: <strong>{current.version}</strong> — {current.title}
            {current.published_at && ` (published ${formatDate(current.published_at)})`}
          </div>
        ) : (
          <div className="alert alert-error" style={{ marginBottom: 0 }}>
            No contract is published — new clients cannot sign yet. Upload a
            version below and publish it.
          </div>
        )}
      </div>

      {showUpload && (
        <ContractUpload
          onClose={() => setShowUpload(false)}
          onCreated={() => {
            setShowUpload(false);
            reload();
          }}
        />
      )}

      {actionError && (
        <div className="card-pad" style={{ paddingBottom: 0 }}>
          <div className="alert alert-error">{actionError}</div>
        </div>
      )}

      {contracts.length === 0 ? (
        <EmptyState
          title="No contract versions"
          message="Upload the first version to enable the client e-sign flow."
        />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Version</th>
                <th>Title</th>
                <th>Status</th>
                <th>Content hash</th>
                <th>Published</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {contracts.map((c) => (
                <tr key={c.id}>
                  <td style={{ fontWeight: 600 }}>{c.version}</td>
                  <td>{c.title}</td>
                  <td>
                    <span className={`badge badge-${c.is_current ? 'green' : 'gray'}`}>
                      {c.is_current ? 'Live' : 'Draft'}
                    </span>
                  </td>
                  <td className="mono muted" style={{ fontSize: '0.76rem' }}>
                    {c.content_hash ? `${c.content_hash.slice(0, 12)}…` : '—'}
                  </td>
                  <td className="muted">
                    {c.published_at ? formatDate(c.published_at) : '—'}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {!c.is_current && (
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={publishingId === c.id}
                        onClick={() => publish(c.id)}
                      >
                        {publishingId === c.id ? 'Publishing…' : 'Publish'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ContractUpload({ onClose, onCreated }) {
  const [version, setVersion] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploadError, setUploadError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setUploadError(null);

    if (!version.trim()) {
      setUploadError('A version label is required (e.g. "v2").');
      return;
    }
    if (!title.trim()) {
      setUploadError('A title is required.');
      return;
    }
    if (!body.trim()) {
      setUploadError('Contract text cannot be empty.');
      return;
    }

    setBusy(true);
    try {
      await api.post('/admin/owner/contracts', {
        version: version.trim(),
        title: title.trim(),
        body,
      });
      onCreated();
    } catch (err) {
      setUploadError(err.message || 'Could not upload the contract.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="card-pad" style={{ borderBottom: '1px solid var(--border)' }}>
      <div className="section-title">Upload a new version</div>
      <p className="muted" style={{ fontSize: '0.84rem', marginBottom: 12 }}>
        The version is created as a draft. Publish it afterwards to make it the
        contract new clients sign — existing signatures are unaffected.
      </p>

      {uploadError && <div className="alert alert-error">{uploadError}</div>}

      <label className="field">
        <span className="label">Version</span>
        <input
          type="text"
          value={version}
          onChange={(e) => setVersion(e.target.value)}
          placeholder="v2"
        />
      </label>

      <label className="field">
        <span className="label">Title</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="SoCal Receptionist Service Agreement"
        />
      </label>

      <label className="field">
        <span className="label">Contract text</span>
        <textarea
          className="code"
          rows={14}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Markdown — the exact text clients will sign."
        />
        <span className="hint">
          Markdown is supported. The signed copy is frozen by a content hash.
        </span>
      </label>

      {body.trim() && (
        <>
          <div className="section-title">Preview</div>
          <Markdown source={body} />
        </>
      )}

      <div className="row-gap" style={{ marginTop: 16 }}>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Uploading…' : 'Upload version'}
        </button>
        <button className="btn btn-secondary" type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </form>
  );
}
