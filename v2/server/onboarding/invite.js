// Public invite acceptance — a user invited to a tenant sets their name +
// password here, which creates (or links) their auth account and activates
// their tenant_members row. MFA is enforced by the app on first login.
//
//   GET  /invite/:token          -> { email, tenant_name, expired } | { accepted }
//   POST /invite/:token/accept   -> { ok } after { full_name, password }

const express = require('express');
const { supabase } = require('../lib/supabase');

const router = express.Router();

router.get('/invite/:token', async (req, res) => {
  try {
    const { data: m } = await supabase
      .from('tenant_members')
      .select('id, email, status, invite_expires_at, tenant_id')
      .eq('invite_token', req.params.token)
      .maybeSingle();
    if (!m) return res.status(404).json({ error: 'Invite not found.' });
    if (m.status === 'active') return res.json({ accepted: true, email: m.email });
    const expired = m.invite_expires_at && new Date(m.invite_expires_at) < new Date();
    const { data: t } = await supabase
      .from('tenants').select('business_name').eq('id', m.tenant_id).maybeSingle();
    res.json({ email: m.email, tenant_name: t?.business_name || 'your team', expired: !!expired });
  } catch (err) {
    console.error('[invite] lookup failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.post('/invite/:token/accept', express.json(), async (req, res) => {
  try {
    const full_name = String(req.body.full_name || '').trim();
    const password = String(req.body.password || '');
    if (full_name.length < 2) return res.status(400).json({ error: 'Please enter your full name.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const { data: m } = await supabase
      .from('tenant_members')
      .select('id, email, status, invite_expires_at')
      .eq('invite_token', req.params.token)
      .maybeSingle();
    if (!m) return res.status(404).json({ error: 'Invite not found.' });
    if (m.status === 'active') return res.status(409).json({ error: 'This invite was already accepted. Please sign in.' });
    if (m.invite_expires_at && new Date(m.invite_expires_at) < new Date()) {
      return res.status(410).json({ error: 'This invite has expired. Ask the account owner to resend it.' });
    }

    // Create the auth user, or link/refresh an existing one with the same email.
    let userId;
    const { data: created, error: cErr } = await supabase.auth.admin.createUser({
      email: m.email, password, email_confirm: true, user_metadata: { full_name },
    });
    if (created?.user) {
      userId = created.user.id;
    } else if (cErr && /registered|already|exists/i.test(cErr.message || '')) {
      const { data: list } = await supabase.auth.admin.listUsers();
      const found = (list?.users || []).find((u) => (u.email || '').toLowerCase() === m.email.toLowerCase());
      if (!found) return res.status(500).json({ error: 'Could not link your existing account.' });
      userId = found.id;
      await supabase.auth.admin.updateUserById(userId, { password, user_metadata: { full_name } });
    } else {
      console.error('[invite] createUser failed:', cErr?.message);
      return res.status(500).json({ error: 'Could not create your account.' });
    }

    await supabase.from('tenant_members').update({
      user_id: userId,
      full_name,
      status: 'active',
      accepted_at: new Date().toISOString(),
      invite_token: null,
      invite_expires_at: null,
    }).eq('id', m.id);

    res.json({ ok: true });
  } catch (err) {
    console.error('[invite] accept failed:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
