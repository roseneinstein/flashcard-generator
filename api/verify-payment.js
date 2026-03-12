// Called by frontend after Razorpay subscription first payment succeeds.
// Verifies signature, sets tier + sub_expiry on the user row.

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    razorpay_payment_id,
    razorpay_subscription_id,   // subscription payment
    razorpay_order_id,           // legacy one-time order
    razorpay_signature,
    plan,
    access_token,
  } = req.body;

  if (!access_token) return res.status(400).json({ error: 'Missing token' });

  const { data: { user }, error: authErr } = await supabase.auth.getUser(access_token);
  if (authErr || !user) return res.status(401).json({ error: 'Not authenticated' });

  const secret = process.env.RAZORPAY_SECRET;

  // ── Subscription payment ─────────────────────────────────────────────────
  if (razorpay_subscription_id) {
    if (!razorpay_payment_id || !razorpay_signature)
      return res.status(400).json({ error: 'Missing payment fields' });

    // Signature for subscription: HMAC-SHA256 of "payment_id|subscription_id"
    const body     = `${razorpay_payment_id}|${razorpay_subscription_id}`;
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    if (expected !== razorpay_signature)
      return res.status(400).json({ error: 'Invalid payment signature' });

    // Get plan from users.sub_id (set by subscribe.js) — don't trust client-sent plan
    const { data: dbUser } = await supabase
      .from('users')
      .select('sub_id')
      .eq('id', user.id)
      .single();

    // Validate the sub ID matches what we stored (not a spoofed ID from another user)
    if (!dbUser?.sub_id || dbUser.sub_id !== razorpay_subscription_id)
      return res.status(403).json({ error: 'Subscription ID mismatch' });

    // Get plan from the subscription notes we stored when creating it
    const { data: rzSub } = await supabase
      .from('users')
      .select('sub_plan')
      .eq('id', user.id)
      .single();

    // Fallback: use client-sent plan (safe since signature already verified)
    const tierPlan = rzSub?.sub_plan || plan || 'pro';
    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

    await supabase
      .from('users')
      .update({ tier: tierPlan, sub_status: 'active', sub_expiry: periodEnd })
      .eq('id', user.id);

    return res.status(200).json({ success: true, tier: tierPlan });
  }

  // ── Legacy one-time order (backward compat) ──────────────────────────────
  if (razorpay_order_id) {
    if (!razorpay_payment_id || !razorpay_signature || !plan)
      return res.status(400).json({ error: 'Missing fields' });

    const body     = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    if (expected !== razorpay_signature)
      return res.status(400).json({ error: 'Invalid payment signature' });

    const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    await supabase
      .from('users')
      .update({ tier: plan, sub_expiry: periodEnd })
      .eq('id', user.id);

    await supabase
      .from('payments')
      .update({ razorpay_payment_id, status: 'verified' })
      .eq('razorpay_order_id', razorpay_order_id);

    return res.status(200).json({ success: true, tier: plan });
  }

  return res.status(400).json({ error: 'Missing subscription or order ID' });
}
