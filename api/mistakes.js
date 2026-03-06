// GET    — list mistakes for user
// POST   — save a mistake
// DELETE — clear all mistakes (?all=true) or one (?id=xxx)
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
      .from('mistakes').select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ mistakes: data || [] });
  }

  if (req.method === 'POST') {
    const { id, set_id, set_name, question, options, correct, explanation } = req.body;
    if (!id || !set_name || !question) return res.status(400).json({ error: 'Missing fields' });
    const { error } = await supabase.from('mistakes').insert({
      id, user_id: user.id,
      set_id: set_id||null, set_name,
      question, options: options||[], correct, explanation: explanation||'',
    });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const { all, id } = req.query;
    if (all) {
      const { error } = await supabase.from('mistakes').delete().eq('user_id', user.id);
      if (error) return res.status(500).json({ error: error.message });
    } else if (id) {
      const { error } = await supabase.from('mistakes').delete()
        .eq('id', id).eq('user_id', user.id);
      if (error) return res.status(500).json({ error: error.message });
    }
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
