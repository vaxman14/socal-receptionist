// Centralized API client for the V2 backend.
//
// Every request:
//   * is prefixed with VITE_API_BASE
//   * carries `Authorization: Bearer <supabase access_token>`
//   * on 401, clears the session and bounces the user to /login
//
// Callers get parsed JSON on success, or a thrown ApiError on failure.

import { supabase } from './supabase';

const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

// Allows the auth layer to react to a hard 401 (sign-out + redirect).
let onUnauthorized = null;
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

async function authHeader() {
  const { data } = await supabase.auth.getSession();
  const token = data?.session?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request(method, path, body) {
  if (!API_BASE) {
    throw new ApiError('VITE_API_BASE is not configured.', 0);
  }

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(await authHeader()),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new ApiError('Network error — could not reach the server.', 0);
  }

  if (res.status === 401) {
    if (onUnauthorized) onUnauthorized();
    throw new ApiError('Your session has expired. Please sign in again.', 401);
  }

  // Some endpoints (printable agreement) return HTML, not JSON.
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    if (!res.ok) {
      throw new ApiError(`Request failed (${res.status}).`, res.status);
    }
    return res.text();
  }

  let payload = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }

  if (!res.ok) {
    const message =
      (payload && (payload.error || payload.message)) ||
      `Request failed (${res.status}).`;
    throw new ApiError(message, res.status);
  }

  return payload;
}

// Authenticated binary fetch (audio, files). Returns an object URL the caller
// must revoke with URL.revokeObjectURL when done.
async function getBlobUrl(path) {
  if (!API_BASE) throw new ApiError('VITE_API_BASE is not configured.', 0);
  const res = await fetch(`${API_BASE}${path}`, { headers: await authHeader() });
  if (res.status === 401) {
    if (onUnauthorized) onUnauthorized();
    throw new ApiError('Your session has expired. Please sign in again.', 401);
  }
  if (!res.ok) throw new ApiError(`Request failed (${res.status}).`, res.status);
  return URL.createObjectURL(await res.blob());
}

export const api = {
  base: API_BASE,
  get: (path) => request('GET', path),
  getBlobUrl,
  post: (path, body) => request('POST', path, body ?? {}),
  put: (path, body) => request('PUT', path, body ?? {}),
  patch: (path, body) => request('PATCH', path, body ?? {}),
  delete: (path) => request('DELETE', path),
};
