// Role detection.
//
// After a session exists, decide which surface to render:
//   1. GET /admin/owner/stats  -> 200 means platform owner.
//   2. else GET /onboarding/business -> tenant null = onboarding wizard,
//      tenant present = client dashboard.
//
// Results are cached in sessionStorage (10 min TTL) so returning to the app
// after switching away doesn't show a loading screen on every reload.
//
// Returns { role, tenant, loading, error, reload }.
//   role: 'owner' | 'client' | 'onboarding' | null

import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { useAuth } from './AuthContext';

const ROLE_CACHE_TTL = 10 * 60 * 1000; // 10 min

function readRoleCache(userId) {
  try {
    const raw = sessionStorage.getItem(`scr.role.${userId}`);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (Date.now() - v.ts < ROLE_CACHE_TTL) return v;
  } catch {}
  return null;
}

function writeRoleCache(userId, role, tenant) {
  try {
    sessionStorage.setItem(`scr.role.${userId}`, JSON.stringify({ role, tenant, ts: Date.now() }));
  } catch {}
}

export function useRole() {
  const { session } = useAuth();
  const userId = session?.user?.id;

  const [state, setState] = useState(() => {
    if (!userId) return { role: null, tenant: null, loading: true, error: null };
    const cached = readRoleCache(userId);
    if (cached) return { role: cached.role, tenant: cached.tenant, loading: false, error: null };
    return { role: null, tenant: null, loading: true, error: null };
  });

  const detect = useCallback(async () => {
    // Only show loading spinner when there's no cached role to display.
    if (!readRoleCache(userId)) {
      setState((s) => ({ ...s, loading: true, error: null }));
    }
    try {
      // Owner check first.
      try {
        await api.get('/admin/owner/stats');
        const next = { role: 'owner', tenant: null, loading: false, error: null };
        setState(next);
        if (userId) writeRoleCache(userId, 'owner', null);
        return;
      } catch (err) {
        // 401 is handled globally; anything else here just means "not owner".
        if (err instanceof ApiError && err.status === 401) throw err;
      }

      // Not the owner — does this account have a tenant yet?
      const data = await api.get('/onboarding/business');
      if (data && data.tenant) {
        setState({ role: 'client', tenant: data.tenant, loading: false, error: null });
        if (userId) writeRoleCache(userId, 'client', data.tenant);
      } else {
        setState({ role: 'onboarding', tenant: null, loading: false, error: null });
        // Don't cache 'onboarding' — it changes once setup is done.
      }
    } catch (err) {
      setState({
        role: null,
        tenant: null,
        loading: false,
        error: err.message || 'Could not determine your account type.',
      });
    }
  }, [userId]);

  useEffect(() => {
    if (userId) {
      detect();
    } else {
      setState({ role: null, tenant: null, loading: false, error: null });
    }
  }, [userId, detect]);

  return { ...state, reload: detect };
}
