// Creates a Razorpay subscription for Pro (₹99/mo) or Elite (₹199/mo).
// Requires env vars: RAZORPAY_PLAN_PRO and RAZORPAY_PLAN_ELITE (Razorpay plan IDs).
// If those are missing, call GET /api/subscribe?setup=1 once to auto-create them.
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
// Hit this URL once after deploy to create plans in Razorpay.
// Copy the returned plan IDs into Vercel env vars and redeploy.
async function handleSetup(res) {
  try {
    const pro = await razorpay.plans.create({
      period: 'monthly', interval: 1,
      item: { name: 'CogniSwift Pro', amount: 9900, currency: 'INR', description: 'Pro plan ₹99/month' },
    });
    const elite = await razorpay.plans.create({
      period: 'monthly', interval: 1,
      item: { name: 'CogniSwift Elite', amount: 19900, currency: 'INR', description: 'Elite plan ₹199/month' },
    });
    return res.status(200).json({
      message: 'Plans created! Add these to Vercel env vars and redeploy:',
      RAZORPAY_PLAN_PRO:   pro.id,
      RAZORPAY_PLAN_ELITE: elite.id,
    });
  } catch (err) {
    return res.status(500).json({ error: 'Plan creation failed: ' + err.message });
  }
}

export default async function handler(req, res) {
  // One-time setup endpoint
  if (req.method === 'GET' && req.query.setup === '1') return handleSetup(res);

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { plan, access_token } = req.body;
  if (!plan || !access_token) return res.status(400).json({ error: 'Missing plan or token' });
  if (plan !== 'pro' && plan !== 'elite') return res.status(400).json({ error: 'Invalid plan' });

  // Verify user identity
  const { data: { user }, error: authErr } = await supabase.auth.getUser(access_token);
  if (authErr || !user) return res.status(401).json({ error: 'Not authenticated' });

  // Get Razorpay plan ID from env
  const planId = plan === 'pro' ? process.env.RAZORPAY_PLAN_PRO : process.env.RAZORPAY_PLAN_ELITE;
  if (!planId) {
    return res.status(500).json({
      error: `Razorpay plan ID not set. Visit /api/subscribe?setup=1 to auto-create plans, then add RAZORPAY_PLAN_${plan.toUpperCase()} to Vercel env vars.`,
    });
  }

  // Fetch current user subscription state
  const { data: dbUser } = await supabase
    .from('users')
    .select('sub_id, sub_status, tier')
    .eq('id', user.id)
    .single();

  const activeTier = dbUser?.tier || 'free';
  const activeSub  = dbUser?.sub_id;
  const subStatus  = dbUser?.sub_status;

  // Already on this plan and active — no new subscription needed
  if (activeTier === plan && subStatus === 'active') {
    return res.status(400).json({ error: `You already have an active ${plan} subscription.` });
  }

  // Upgrading Pro → Elite: cancel existing sub first (Razorpay doesn't support mid-cycle upgrades)
  if (activeSub && subStatus === 'active' && plan === 'elite' && activeTier === 'pro') {
    try {
      await razorpay.subscriptions.cancel(activeSub, { cancel_at_cycle_end: false });
    } catch (e) { /* best effort — webhook will clean up */ }
  }

  try {
    const subscription = await razorpay.subscriptions.create({
      plan_id:         planId,
      total_count:     120,   // 10 years — effectively indefinite recurring
      quantity:        1,
      customer_notify: 1,     // Razorpay sends payment reminder emails
      notes:           { user_id: user.id, plan },
    });

    // Persist subscription ID immediately so webhook can find the user
    await supabase.from('users').update({
      sub_id:     subscription.id,
      sub_status: 'created',
      sub_plan:   plan,
    }).eq('id', user.id);

    return res.status(200).json({
      subscription_id: subscription.id,
      key_id:          process.env.RAZORPAY_KEY_ID,
      plan,
      email:           user.email,
      name:            user.user_metadata?.full_name || '',
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
