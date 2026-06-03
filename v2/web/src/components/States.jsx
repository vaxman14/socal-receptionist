// Reusable loading / error / empty / pagination states.

export function Loading({ label = 'Loading…' }) {
  return (
    <div className="state">
      <div className="spinner" />
      <div>{label}</div>
    </div>
  );
}

export function ErrorState({ message, onRetry }) {
  return (
    <div className="state">
      <h3>Something went wrong</h3>
      <p>{message || 'An unexpected error occurred.'}</p>
      {onRetry && (
        <button className="btn btn-secondary" style={{ marginTop: 14 }} onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title = 'Nothing here yet', message }) {
  return (
    <div className="state">
      <h3>{title}</h3>
      {message && <p>{message}</p>}
    </div>
  );
}

// Prev / Next pagination controls.
// Props: page (current 1-based page), total (total record count), limit,
//        onPage (fn called with new page number).
export function Pagination({ page, total, limit, onPage }) {
  const totalPages = Math.max(1, Math.ceil(total / limit));
  if (totalPages <= 1) return null;
  const start = (page - 1) * limit + 1;
  const end = Math.min(page * limit, total);
  return (
    <div className="pagination">
      <button
        className="btn btn-secondary btn-sm"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      >
        ← Prev
      </button>
      <span className="pagination-info">
        {start}–{end} of {total}
      </span>
      <button
        className="btn btn-secondary btn-sm"
        disabled={page >= totalPages}
        onClick={() => onPage(page + 1)}
      >
        Next →
      </button>
    </div>
  );
}
