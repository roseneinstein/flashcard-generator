// Single endpoint for all user data operations.
// Route via ?resource=usage|sets|history|mistakes
// Methods: GET, POST, DELETE per resource (see below)

import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function getUser(req) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return null;
  const { data: { user }, error } = await supabase.auth.getUser(token);
  return (error || !user) ? null : user;
}

export default async function handler(req, res) {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: 'Not authenticated' });

  const resource = req.query.resource;

  // ── USAGE ──────────────────────────────────────────────────────────────────
  if (resource === 'usage') {
    const today = new Date().toISOString().slice(0, 10);

    if (req.method === 'GET') {
      const { data } = await supabase
        .from('users').select('daily_count,count_date').eq('id', user.id).single();
      const count = (data?.count_date === today) ? (data.daily_count || 0) : 0;
      return res.status(200).json({ count });
    }

    if (req.method === 'POST') {
      const { data } = await supabase
        .from('users').select('daily_count,count_date').eq('id', user.id).single();
      const current = (data?.count_date === today) ? (data.daily_count || 0) : 0;
      const newCount = current + 1;
      await supabase.from('users')
        .update({ daily_count: newCount, count_date: today }).eq('id', user.id);
      return res.status(200).json({ count: newCount });
    }
  }

  // ── SETS ───────────────────────────────────────────────────────────────────
  if (resource === 'sets') {
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('sets').select('*').eq('user_id', user.id)
        .order('saved_at', { ascending: false });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ sets: data || [] });
    }

    if (req.method === 'POST') {
      const { id, name, cards, quiz, summary } = req.body;
      if (!id || !name) return res.status(400).json({ error: 'Missing id or name' });
      const { error } = await supabase.from('sets').insert({
        id, user_id: user.id, name,
        cards: cards || [], quiz: quiz || [], summary: summary || null,
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
  }

  // ── HISTORY ────────────────────────────────────────────────────────────────
  if (resource === 'history') {
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('quiz_history').select('*').eq('user_id', user.id)
        .order('completed_at', { ascending: false }).limit(100);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ history: data || [] });
    }

    if (req.method === 'POST') {
      const { id, set_id, set_name, score, total } = req.body;
      if (!id || !set_name) return res.status(400).json({ error: 'Missing fields' });
      const { error } = await supabase.from('quiz_history').insert({
        id, user_id: user.id, set_id: set_id || null, set_name, score, total,
      });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const { set_name } = req.query;
      if (set_name) {
        const { error } = await supabase.from('quiz_history')
          .delete().eq('user_id', user.id).eq('set_name', set_name);
        if (error) return res.status(500).json({ error: error.message });
      }
      return res.status(200).json({ ok: true });
    }
  }

  // ── MISTAKES ───────────────────────────────────────────────────────────────
  if (resource === 'mistakes') {
    if (req.method === 'GET') {
      const { data, error } = await supabase
        .from('mistakes').select('*').eq('user_id', user.id)
        .order('created_at', { ascending: false }).limit(200);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ mistakes: data || [] });
    }

    if (req.method === 'POST') {
      const { id, set_id, set_name, question, options, correct, explanation } = req.body;
      if (!id || !set_name || !question) return res.status(400).json({ error: 'Missing fields' });
      const { error } = await supabase.from('mistakes').insert({
        id, user_id: user.id,
        set_id: set_id || null, set_name,
        question, options: options || [], correct, explanation: explanation || '',
      });
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ ok: true });
    }

    if (req.method === 'DELETE') {
      const { all, id, set_name } = req.query;
      if (all) {
        const { error } = await supabase.from('mistakes').delete().eq('user_id', user.id);
        if (error) return res.status(500).json({ error: error.message });
      } else if (set_name) {
        const { error } = await supabase.from('mistakes')
          .delete().eq('user_id', user.id).eq('set_name', set_name);
        if (error) return res.status(500).json({ error: error.message });
      } else if (id) {
        const { error } = await supabase.from('mistakes')
          .delete().eq('id', id).eq('user_id', user.id);
        if (error) return res.status(500).json({ error: error.message });
      }
      return res.status(200).json({ ok: true });
    }
  }

  return res.status(400).json({ error: 'Unknown resource or method' });
}
