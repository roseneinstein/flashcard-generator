import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { access_token } = req.body;
  if (!access_token) return res.status(400).json({ error: 'Missing token' });

  // Verify token with Supabase and get user identity
  const { data: { user }, error } = await supabase.auth.getUser(access_token);
  if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' });

  // Upsert user row — creates on first login, no-ops on repeat
  const { data, error: dbErr } = await supabase
    .from('users')
    .upsert(
      { id: user.id, email: user.email },
      { onConflict: 'id', ignoreDuplicates: false }
    )
    .select('tier')
    .single();

  if (dbErr) return res.status(500).json({ error: dbErr.message });

  return res.status(200).json({
    id:     user.id,
    email:  user.email,
    tier:   data?.tier || 'free',
    avatar: user.user_metadata?.avatar_url  || null,
    name:   user.user_metadata?.full_name   || user.email,
  });
}
