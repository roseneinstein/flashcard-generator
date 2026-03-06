// Saves cards to Supabase and returns a short share ID
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function randomId(len = 7) {
  const chars = 'abcdefghijkmnpqrstuvwxyz23456789'; // no confusable chars (0,o,1,l)
  let id = '';
  for (let i = 0; i < len; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { cards } = req.body;
  if (!Array.isArray(cards) || !cards.length)
    return res.status(400).json({ error: 'No cards provided' });
  if (cards.length > 25)
    return res.status(400).json({ error: 'Too many cards' });

  // Generate a unique short ID (retry on collision — extremely rare)
  let id, attempts = 0;
  while (attempts < 5) {
    const candidate = randomId();
    const { data } = await supabase
      .from('shares')
      .select('id')
      .eq('id', candidate)
      .maybeSingle();
    if (!data) { id = candidate; break; }
    attempts++;
  }
  if (!id) return res.status(500).json({ error: 'Could not generate ID, try again' });

  const { error } = await supabase
    .from('shares')
    .insert({ id, cards, created_at: new Date().toISOString() });

  if (error) return res.status(500).json({ error: error.message });

  return res.status(200).json({ id });
}
