import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { access_token } = req.body;
  if (!access_token) return res.status(400).json({ error: 'Missing token' });

  const { data: { user }, error } = await supabase.auth.getUser(access_token);
  if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' });

  // Upsert user row — creates on first login, no-ops on repeat
  const { data, error: dbErr } = await supabase
    .from('users')
    .upsert(
      { id: user.id, email: user.email },
      { onConflict: 'id', ignoreDuplicates: false }
    )
    .select('tier, sub_expiry, sub_status')
    .single();

  if (dbErr) return res.status(500).json({ error: dbErr.message });

  let tier      = data?.tier       || 'free';
  let subExpiry = data?.sub_expiry || null;
  let subStatus = data?.sub_status || null;

  // Safety net: if sub_expiry has passed, downgrade to free.
  // Webhooks handle this in real-time — this catches any gaps.
  if (tier !== 'free' && subExpiry) {
    if (Date.now() > new Date(subExpiry).getTime()) {
      await supabase
        .from('users')
        .update({ tier: 'free', sub_expiry: null, sub_status: 'expired' })
        .eq('id', user.id);
      tier      = 'free';
      subExpiry = null;
      subStatus = 'expired';
    }
  }

  return res.status(200).json({
    id:         user.id,
    email:      user.email,
    tier,
    sub_expiry: subExpiry,   // ISO string or null — frontend shows days remaining
    sub_status: subStatus,   // active | pending_cancel | halted | cancelled | expired | null
    avatar:     user.user_metadata?.avatar_url || null,
    name:       user.user_metadata?.full_name  || user.email,
  });
}
