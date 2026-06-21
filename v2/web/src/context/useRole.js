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

function writeRoleCache(userId, role, tenant, isPlatformAdmin) {
  try {
    sessionStorage.setItem(
      `scr.role.${userId}`,
      JSON.stringify({ role, tenant, isPlatformAdmin: !!isPlatformAdmin, ts: Date.now() }),
    );
  } catch {}
}

export function useRole() {
  const { session } = useAuth();
  const userId = session?.user?.id;

  const [state, setState] = useState(() => {
    if (!userId) return { role: null, tenant: null, isPlatformAdmin: false, loading: true, error: null };
    const cached = readRoleCache(userId);
    if (cached) return { role: cached.role, tenant: cached.tenant, isPlatformAdmin: !!cached.isPlatformAdmin, loading: false, error: null };
    return { role: null, tenant: null, isPlatformAdmin: false, loading: true, error: null };
  });

  const detect = useCallback(async () => {
    // Only show loading spinner when there's no cached role to display.
    if (!readRoleCache(userId)) {
      setState((s) => ({ ...s, loading: true, error: null }));
    }
    try {
      // Platform-admin is a FLAG, not a separate surface. A super-admin who
      // also owns a tenant gets the full client app PLUS an Admin section.
      let isPlatformAdmin = false;
      try {
        await api.get('/admin/owner/stats');
        isPlatformAdmin = true;
      } catch (err) {
        // 401 is handled globally; re-auth.
        if (err instanceof ApiError && err.status === 401) throw err;
        // Only a definitive 403 means "not a platform admin". A network error
        // or a 5xx means we COULDN'T determine it — bail to the error state
        // rather than mislabel a transient outage as "not admin".
        if (!(err instanceof ApiError) || err.status >= 500) throw err;
        // 403 -> genuinely not a platform admin; continue.
      }

      // Does this account have a tenant yet?
      const data = await api.get('/onboarding/business');
      const tenant = data && data.tenant ? data.tenant : null;

      // Surface: a tenant -> client app (+ admin section if admin).
      // No tenant but admin -> pure owner console. Neither -> onboarding wizard.
      const role = tenant ? 'client' : isPlatformAdmin ? 'owner' : 'onboarding';
      setState({ role, tenant, isPlatformAdmin, loading: false, error: null });
      // Don't cache 'onboarding' — it changes once setup is done.
      if (userId && role !== 'onboarding') writeRoleCache(userId, role, tenant, isPlatformAdmin);
    } catch (err) {
      setState({
        role: null,
        tenant: null,
        isPlatformAdmin: false,
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
