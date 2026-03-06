// GET  — list quiz history for user
// POST — save a quiz result
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function getUser(req) {
  const token = (req.headers.authorization||'').replace('Bearer ','');
  if (!token) return null;
  const { data:{ user }, error } = await supabase.auth.getUser(token);
  return (error || !user) ? null : user;
}

export default async function handler(req, res) {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('quiz_history').select('*')
      .eq('user_id', user.id)
      .order('completed_at', { ascending: false })
      .limit(100);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ history: data || [] });
  }

  if (req.method === 'POST') {
    const { id, set_id, set_name, score, total } = req.body;
    if (!id || !set_name) return res.status(400).json({ error: 'Missing fields' });
    const { error } = await supabase.from('quiz_history').insert({
      id, user_id: user.id, set_id: set_id||null, set_name, score, total,
    });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
