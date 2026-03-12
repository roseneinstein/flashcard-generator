// Cancels a user's active subscription at end of current billing cycle.
// User keeps access until sub_expiry date. Webhook then downgrades them to free.

import Razorpay from 'razorpay';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const razorpay = new Razorpay({
  key_id:     process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_SECRET,
});

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { access_token } = req.body;
  if (!access_token) return res.status(400).json({ error: 'Missing token' });

  const { data: { user }, error: authErr } = await supabase.auth.getUser(access_token);
  if (authErr || !user) return res.status(401).json({ error: 'Not authenticated' });

  // Get user's current subscription ID
  const { data: dbUser } = await supabase
    .from('users')
    .select('sub_id, sub_status, sub_expiry, tier')
    .eq('id', user.id)
    .single();

  if (!dbUser?.sub_id || dbUser.sub_status !== 'active') {
    return res.status(404).json({ error: 'No active subscription found' });
  }

  try {
    // cancel_at_cycle_end=1: user keeps access until period ends, not cut off immediately
    await razorpay.subscriptions.cancel(dbUser.sub_id, { cancel_at_cycle_end: 1 });

    await supabase
      .from('users')
      .update({ sub_status: 'pending_cancel' })
      .eq('id', user.id);

    return res.status(200).json({
      ok:                 true,
      message:            'Subscription will cancel at end of billing period.',
      access_until:       dbUser.sub_expiry,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Could not cancel' });
  }
}
