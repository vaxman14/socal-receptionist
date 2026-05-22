// Auth middleware for the admin API.
//
// The frontend sends a Supabase access token (Authorization: Bearer <jwt>).
// The backend uses the service-role client, which bypasses RLS — so every
// admin route MUST scope its own queries. These middlewares establish who the
// caller is and which tenant they are allowed to touch.

const { supabase } = require('./supabase');

// Verify the bearer token and attach req.user.
async function requireAuth(req, res, next) {
  try {
    const header = req.header('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'missing bearer token' });

    const { data, error } = await supabase.auth.getUser(token);
    if (error || !data || !data.user) {
      return res.status(401).json({ error: 'invalid token' });
    }
    req.user = data.user;
    return next();
  } catch (err) {
    console.error('[auth] requireAuth failed:', err.message);
    return res.status(500).json({ error: 'auth check failed' });
  }
}

// Require the caller to be a platform admin (Roman). Use after requireAuth.
async function requirePlatformAdmin(req, res, next) {
  try {
    const { data } = await supabase
      .from('platform_admins')
      .select('user_id')
      .eq('user_id', req.user.id)
      .maybeSingle();
    if (!data) return res.status(403).json({ error: 'platform admin only' });
    req.isPlatformAdmin = true;
    return next();
  } catch (err) {
    console.error('[auth] requirePlatformAdmin failed:', err.message);
    return res.status(500).json({ error: 'auth check failed' });
  }
}

// Require the caller's session to be at Authenticator Assurance Level 2 — i.e.
// they have signed in AND cleared an MFA factor (or are on a trusted device
// that elevated them). Use after requireAuth.
//
// Supabase encodes the assurance level in the access token's `aal` claim
// ('aal1' = password only, 'aal2' = a second factor was presented). This is an
// OPT-IN middleware: existing routes keep using requireAuth and are unchanged.
// It is provided for any future route that must be MFA-gated server-side.
async function requireAal2(req, res, next) {
  try {
    const header = req.header('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'missing bearer token' });

    // Decode (not verify) the JWT payload — requireAuth already verified the
    // token with Supabase; here we only need to read the `aal` claim.
    const parts = token.split('.');
    if (parts.length !== 3) return res.status(401).json({ error: 'invalid token' });
    let claims;
    try {
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      return res.status(401).json({ error: 'invalid token' });
    }

    if (claims.aal !== 'aal2') {
      return res.status(403).json({ error: 'mfa required', code: 'aal2_required' });
    }
    return next();
  } catch (err) {
    console.error('[auth] requireAal2 failed:', err.message);
    return res.status(500).json({ error: 'auth check failed' });
  }
}

// Load the tenant owned by the caller and attach req.tenant. Use after requireAuth.
async function requireTenant(req, res, next) {
  try {
    const { data, error } = await supabase
      .from('tenants')
      .select('*')
      .eq('owner_user_id', req.user.id)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'no tenant for this account' });
    req.tenant = data;
    return next();
  } catch (err) {
    console.error('[auth] requireTenant failed:', err.message);
    return res.status(500).json({ error: 'tenant lookup failed' });
  }
}

module.exports = { requireAuth, requirePlatformAdmin, requireTenant, requireAal2 };
