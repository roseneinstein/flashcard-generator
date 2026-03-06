// GET    — list all sets for user
// POST   — save a new set
// DELETE — delete a set by id (?id=xxx)
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
      .from('sets').select('*')
      .eq('user_id', user.id)
      .order('saved_at', { ascending: false });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ sets: data || [] });
  }

  if (req.method === 'POST') {
    const { id, name, cards, quiz, summary } = req.body;
    if (!id || !name) return res.status(400).json({ error: 'Missing id or name' });
    const { error } = await supabase.from('sets').insert({
      id, user_id: user.id, name,
      cards: cards || [],
      quiz:  quiz  || [],
      summary: summary || null,
    });
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id) return res.status(400).json({ error: 'Missing id' });
    const { error } = await supabase.from('sets')
      .delete().eq('id', id).eq('user_id', user.id);
    if (error) return res.status(500).json({ error: error.message });
    return res.status(200).json({ ok: true });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
