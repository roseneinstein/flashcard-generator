// GET  — returns today's usage count for the logged-in user
// POST — increments usage count by 1, returns new count
import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

export default async function handler(req, res) {
  const token = (req.headers.authorization||'').replace('Bearer ','');
  if (!token) return res.status(401).json({ error: 'No token' });

  const { data:{ user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });

  const today = new Date().toISOString().slice(0,10); // YYYY-MM-DD

  if (req.method === 'GET') {
    const { data } = await supabase
      .from('users').select('daily_count,count_date').eq('id', user.id).single();
    const count = (data?.count_date === today) ? (data.daily_count || 0) : 0;
    return res.status(200).json({ count });
  }

  if (req.method === 'POST') {
    // Read current
    const { data } = await supabase
      .from('users').select('daily_count,count_date').eq('id', user.id).single();
    const current = (data?.count_date === today) ? (data.daily_count || 0) : 0;
    const newCount = current + 1;
    await supabase.from('users')
      .update({ daily_count: newCount, count_date: today })
      .eq('id', user.id);
    return res.status(200).json({ count: newCount });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
