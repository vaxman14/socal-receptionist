// Role detection.
//
// After a session exists, decide which surface to render:
//   1. GET /admin/owner/stats  -> 200 means platform owner.
//   2. else GET /onboarding/business -> tenant null = onboarding wizard,
//      tenant present = client dashboard.
//
// Returns { role, tenant, loading, error, reload }.
//   role: 'owner' | 'client' | 'onboarding' | null

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from './AuthContext';

export function useRole() {
  const { session } = useAuth();
  const [state, setState] = useState({
    role: null,
    tenant: null,
    loading: true,
    error: null,
  });

  const detect = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      // Owner check first.
      try {
        await api.get('/admin/owner/stats');
        setState({ role: 'owner', tenant: null, loading: false, error: null });
        return;
      } catch (err) {
        // 401 is handled globally; anything else here just means "not owner".
        if (err instanceof ApiError && err.status === 401) throw err;
      }

      // Not the owner — does this account have a tenant yet?
      const data = await api.get('/onboarding/business');
      if (data && data.tenant) {
        setState({ role: 'client', tenant: data.tenant, loading: false, error: null });
      } else {
        setState({ role: 'onboarding', tenant: null, loading: false, error: null });
      }
    } catch (err) {
      setState({
        role: null,
        tenant: null,
        loading: false,
        error: err.message || 'Could not determine your account type.',
      });
    }
  }, []);

  useEffect(() => {
    if (session) {
      detect();
    } else {
      setState({ role: null, tenant: null, loading: false, error: null });
    }
  }, [session, detect]);

  return { ...state, reload: detect };
}
