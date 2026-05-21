// useFetch — standardizes the load/error/data cycle for a GET endpoint.
// Returns { data, loading, error, reload }.

import { useCallback, useEffect, useState } from 'react';
import { api } from './api';

export function useFetch(path, { skip = false } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(!skip);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    setError(null);
    try {
      const result = await api.get(path);
      setData(result);
    } catch (err) {
      setError(err.message || 'Failed to load.');
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    if (skip) {
      setLoading(false);
      return;
    }
    load();
  }, [load, skip]);

  return { data, loading, error, reload: load };
}
