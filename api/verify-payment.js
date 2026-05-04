// Called by frontend immediately after Razorpay payment succeeds.
// Handles both subscription payments (Pro/Elite monthly/annual)
// and one-time daily payments (Pro/Elite daily trial).

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
    razorpay_subscription_id,
    razorpay_order_id,
    razorpay_signature,
    plan,
    billing,
    access_token,
  } = req.body;

  if (!access_token) return res.status(400).json({ error: 'Missing token' });

  const { data: { user }, error: authErr } = await supabase.auth.getUser(access_token);
  if (authErr || !user) return res.status(401).json({ error: 'Not authenticated' });

  const secret = process.env.RAZORPAY_SECRET;

  // ── DAILY: one-time order verification ───────────────────────────────────
  if (billing === 'daily' && razorpay_order_id) {
    if (!razorpay_payment_id || !razorpay_signature)
      return res.status(400).json({ error: 'Missing payment fields' });

    const body     = `${razorpay_order_id}|${razorpay_payment_id}`;
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    if (expected !== razorpay_signature)
      return res.status(400).json({ error: 'Invalid payment signature' });

    // 24 hours from now
    const dailyExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    // Check if user already has a better active paid subscription — don't overwrite
    const { data: existingUser } = await supabase
      .from('users')
      .select('tier, sub_status, sub_billing')
      .eq('id', user.id)
      .single();

    const hasActivePaidSub = existingUser?.sub_status === 'active' &&
                             (existingUser?.sub_billing === 'monthly' ||
                              existingUser?.sub_billing === 'annual');
    if (hasActivePaidSub) {
      return res.status(400).json({
        error: 'You already have an active subscription. Daily trial cannot be applied.',
      });
    }

    const { error: upErr } = await supabase
      .from('users')
      .update({
        tier:        plan,
        sub_status:  'active',
        sub_expiry:  dailyExpiry,
        sub_billing: 'daily',
        sub_plan:    plan,
        // Clear any old sub_id so we don't accidentally cancel a future subscription
        sub_id:      null,
      })
      .eq('id', user.id);

    if (upErr) return res.status(500).json({ error: upErr.message });

    // Mark payment as captured
    await supabase.from('payments')
      .update({ razorpay_payment_id, status: 'captured' })
      .eq('razorpay_order_id', razorpay_order_id);

    console.log(`[CogniSwift] Daily ${plan} activated for user ${user.id}, expires ${dailyExpiry}`);

    return res.status(200).json({
      success:      true,
      tier:         plan,
      billing:      'daily',
      sub_expiry:   dailyExpiry,
      is_daily:     true,
    });
  }

  // ── SUBSCRIPTION: monthly/annual verification ─────────────────────────────
  if (razorpay_subscription_id) {
    if (!razorpay_payment_id || !razorpay_signature)
      return res.status(400).json({ error: 'Missing payment fields' });

    const body     = `${razorpay_payment_id}|${razorpay_subscription_id}`;
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    if (expected !== razorpay_signature)
      return res.status(400).json({ error: 'Invalid payment signature' });

    const { data: dbUser } = await supabase
      .from('users')
      .select('sub_id, sub_plan, sub_billing')
      .eq('id', user.id)
      .single();

    const tierPlan = dbUser?.sub_plan || plan || 'pro';

    // IMPORTANT: Never use sub_billing from DB if it is 'daily' — that is a stale value
    // from a daily trial. Always prefer the billing field from the request body for
    // monthly/annual subscriptions, falling back to 'monthly' as a safe default.
    const dbBilling = dbUser?.sub_billing;
    const billingCycle = (dbBilling && dbBilling !== 'daily')
      ? dbBilling
      : (billing && billing !== 'daily' ? billing : 'monthly');

    const days      = billingCycle === 'annual' ? 365 : 30;
    const periodEnd = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

    const { error: upErr } = await supabase
      .from('users')
      .update({
        tier:        tierPlan,
        sub_status:  'active',
        sub_expiry:  periodEnd,
        sub_billing: billingCycle,
      })
      .eq('id', user.id);

    if (upErr) return res.status(500).json({ error: upErr.message });

    return res.status(200).json({ success: true, tier: tierPlan, billing: billingCycle });
  }

  // ── LEGACY: one-time order (non-daily, backward compat) ──────────────────
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
