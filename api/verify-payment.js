// Called by frontend after Razorpay payment success
// Verifies signature and upgrades user tier in Supabase
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { razorpay_order_id, razorpay_payment_id, razorpay_signature, plan, access_token } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !plan || !access_token)
    return res.status(400).json({ error: 'Missing fields' });

  // 1. Verify who is paying
  const { data: { user }, error: authErr } = await supabase.auth.getUser(access_token);
  if (authErr || !user) return res.status(401).json({ error: 'Not authenticated' });

  // 2. Verify Razorpay signature to confirm payment is genuine
  const body     = `${razorpay_order_id}|${razorpay_payment_id}`;
  const expected = crypto.createHmac('sha256', process.env.RAZORPAY_SECRET).update(body).digest('hex');
  if (expected !== razorpay_signature)
    return res.status(400).json({ error: 'Invalid payment signature — contact support' });

  // 3. Upgrade user tier in Supabase
  const { error: upErr } = await supabase
    .from('users')
    .update({ tier: plan })
    .eq('id', user.id);

  if (upErr) return res.status(500).json({ error: upErr.message });

  // 4. Mark payment as verified in payments table
  await supabase
    .from('payments')
    .update({ razorpay_payment_id, status: 'verified' })
    .eq('razorpay_order_id', razorpay_order_id);

  return res.status(200).json({ success: true, tier: plan });
}
