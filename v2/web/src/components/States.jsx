// Reusable loading / error / empty states.

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
