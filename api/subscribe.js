// Creates a Razorpay subscription for Pro/Elite, monthly or annual.
// Also handles daily one-time orders for Pro/Elite trial.
// Env vars needed:
//   RAZORPAY_PLAN_PRO          – monthly ₹99
//   RAZORPAY_PLAN_ELITE        – monthly ₹199
//   RAZORPAY_PLAN_PRO_ANNUAL   – annual ₹899
//   RAZORPAY_PLAN_ELITE_ANNUAL – annual ₹1799
// Daily plans are one-time Razorpay orders (no autopay):
//   Pro Daily  – ₹15 one-time
//   Elite Daily – ₹25 one-time

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

// ── One-time plan setup (GET /api/subscribe?setup=1) ─────────────
async function handleSetup(res) {
  try {
    const proM = await razorpay.plans.create({
      period: 'monthly', interval: 1,
      item: { name: 'CogniSwift Pro Monthly', amount: 9900, currency: 'INR' },
    });
    const eliteM = await razorpay.plans.create({
      period: 'monthly', interval: 1,
      item: { name: 'CogniSwift Elite Monthly', amount: 19900, currency: 'INR' },
    });
    const proA = await razorpay.plans.create({
      period: 'yearly', interval: 1,
      item: { name: 'CogniSwift Pro Annual', amount: 89900, currency: 'INR' },
    });
    const eliteA = await razorpay.plans.create({
      period: 'yearly', interval: 1,
      item: { name: 'CogniSwift Elite Annual', amount: 179900, currency: 'INR' },
    });
    return res.status(200).json({
      message: 'All 4 plans created! Add to Vercel env vars and redeploy:',
      RAZORPAY_PLAN_PRO:          proM.id,
      RAZORPAY_PLAN_ELITE:        eliteM.id,
      RAZORPAY_PLAN_PRO_ANNUAL:   proA.id,
      RAZORPAY_PLAN_ELITE_ANNUAL: eliteA.id,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Plan creation failed: ' + err.message });
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET' && req.query.setup === '1') return handleSetup(res);
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { plan, billing, access_token } = req.body;
  // plan: 'pro' | 'elite'
  // billing: 'monthly' | 'annual' | 'daily'
  const billingCycle = billing === 'annual' ? 'annual' : billing === 'daily' ? 'daily' : 'monthly';

  if (!plan || !access_token) return res.status(400).json({ error: 'Missing plan or token' });
  if (plan !== 'pro' && plan !== 'elite') return res.status(400).json({ error: 'Invalid plan' });

  const { data: { user }, error: authErr } = await supabase.auth.getUser(access_token);
  if (authErr || !user) return res.status(401).json({ error: 'Not authenticated' });

  // ── DAILY: one-time Razorpay order (no subscription, no autopay) ─────────
  if (billingCycle === 'daily') {
    // Don't allow daily if user already has an active paid subscription
    const { data: dbUser } = await supabase
      .from('users')
      .select('tier, sub_status, sub_billing')
      .eq('id', user.id)
      .single();

    const isActivePaid = (dbUser?.sub_status === 'active') &&
                         (dbUser?.sub_billing === 'monthly' || dbUser?.sub_billing === 'annual');
    if (isActivePaid) {
      return res.status(400).json({
        error: `You already have an active ${dbUser.tier} subscription. Daily trial is only for new users.`,
      });
    }

    const dailyAmount = plan === 'elite' ? 2500 : 1500; // ₹25 or ₹15 in paise

    try {
      const order = await razorpay.orders.create({
        amount:   dailyAmount,
        currency: 'INR',
        receipt:  `cs_daily_${user.id.slice(0, 8)}_${Date.now()}`,
        notes:    { user_id: user.id, plan, billing: 'daily' },
      });

      // Log payment intent
      await supabase.from('payments').insert({
        user_id:           user.id,
        razorpay_order_id: order.id,
        plan,
        amount:            dailyAmount,
        status:            'created',
      });

      return res.status(200).json({
        order_id:  order.id,
        amount:    dailyAmount,
        currency:  'INR',
        key_id:    process.env.RAZORPAY_KEY_ID,
        plan,
        billing:   'daily',
        is_daily:  true,
        email:     user.email,
        name:      user.user_metadata?.full_name || '',
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── MONTHLY / ANNUAL: Razorpay subscription (autopay) ───────────────────
  const { data: dbUser } = await supabase
    .from('users')
    .select('sub_id, sub_status, tier, sub_billing')
    .eq('id', user.id)
    .single();

  const activeTier  = dbUser?.tier       || 'free';
  const activeSub   = dbUser?.sub_id;
  const subStatus   = dbUser?.sub_status;

  if (activeTier === plan &&
      subStatus === 'active' &&
      (dbUser?.sub_billing === 'monthly' || dbUser?.sub_billing === 'annual')) {
    return res.status(400).json({ error: `You already have an active ${plan} subscription.` });
  }

  // Pro → Elite upgrade: cancel current sub first
  if (activeSub && subStatus === 'active' && plan === 'elite' && activeTier === 'pro') {
    try {
      await razorpay.subscriptions.cancel(activeSub, { cancel_at_cycle_end: false });
    } catch (e) { /* best effort */ }
  }

  // Pick the right Razorpay plan ID
  let planId;
  if (plan === 'pro'   && billingCycle === 'monthly') planId = process.env.RAZORPAY_PLAN_PRO;
  if (plan === 'elite' && billingCycle === 'monthly') planId = process.env.RAZORPAY_PLAN_ELITE;
  if (plan === 'pro'   && billingCycle === 'annual')  planId = process.env.RAZORPAY_PLAN_PRO_ANNUAL;
  if (plan === 'elite' && billingCycle === 'annual')  planId = process.env.RAZORPAY_PLAN_ELITE_ANNUAL;

  if (!planId) {
    return res.status(500).json({
      error: `Razorpay plan ID not configured for ${plan}/${billingCycle}. Run /api/subscribe?setup=1 to create plans.`,
    });
  }

  try {
    const subscription = await razorpay.subscriptions.create({
      plan_id:         planId,
      total_count:     billingCycle === 'annual' ? 10 : 120,
      quantity:        1,
      customer_notify: 1,
      notes:           { user_id: user.id, plan, billing: billingCycle },
    });

    await supabase.from('users').update({
      sub_id:      subscription.id,
      sub_status:  'created',
      sub_plan:    plan,
      sub_billing: billingCycle,
    }).eq('id', user.id);

    return res.status(200).json({
      subscription_id: subscription.id,
      key_id:          process.env.RAZORPAY_KEY_ID,
      plan,
      billing:         billingCycle,
      email:           user.email,
      name:            user.user_metadata?.full_name || '',
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
