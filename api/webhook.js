// Razorpay webhook handler — subscription lifecycle events.
// Configure in Razorpay dashboard → Webhooks → add URL + secret.
// Events to enable: subscription.activated, subscription.charged,
//   subscription.halted, subscription.cancelled, subscription.completed,
//   payment.captured (legacy one-time orders)

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

function toISO(unixSec) {
  if (!unixSec) return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  return new Date(unixSec * 1000).toISOString();
}

// Look up user by their Razorpay subscription ID stored in users.sub_id
async function getUserBySub(subId) {
  const { data } = await supabase
    .from('users')
    .select('id, tier, plan:sub_status')
    .eq('sub_id', subId)
    .maybeSingle();
  return data || null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const secret    = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_SECRET;
  const signature = req.headers['x-razorpay-signature'];
  const rawBody   = JSON.stringify(req.body);

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  if (expected !== signature) return res.status(400).json({ error: 'Invalid signature' });

  const event   = req.body.event;
  const payload = req.body.payload;

  // ── subscription.activated: first payment done, subscription is live ──
  if (event === 'subscription.activated') {
    const sub = payload?.subscription?.entity;
    if (!sub) return res.status(200).json({ received: true });

    const periodEnd = toISO(sub.current_end);
    const dbUser    = await getUserBySub(sub.id);

    if (dbUser) {
      // Determine tier from notes (set when subscription was created)
      const plan = sub.notes?.plan || 'pro';
      await supabase
        .from('users')
        .update({ tier: plan, sub_status: 'active', sub_expiry: periodEnd })
        .eq('id', dbUser.id);
    }
  }

  // ── subscription.charged: monthly renewal succeeded, extend access ──
  else if (event === 'subscription.charged') {
    const sub = payload?.subscription?.entity;
    if (!sub) return res.status(200).json({ received: true });

    const periodEnd = toISO(sub.current_end);
    const dbUser    = await getUserBySub(sub.id);

    if (dbUser) {
      await supabase
        .from('users')
        .update({ sub_status: 'active', sub_expiry: periodEnd })
        .eq('id', dbUser.id);
    }
  }

  // ── subscription.halted: payment failed after all retries, lock access ──
  else if (event === 'subscription.halted') {
    const sub    = payload?.subscription?.entity;
    if (!sub) return res.status(200).json({ received: true });
    const dbUser = await getUserBySub(sub.id);

    if (dbUser) {
      await supabase
        .from('users')
        .update({ tier: 'free', sub_status: 'halted', sub_expiry: null })
        .eq('id', dbUser.id);
    }
  }

  // ── subscription.cancelled / completed: access ends, downgrade to free ──
  else if (event === 'subscription.cancelled' || event === 'subscription.completed') {
    const sub    = payload?.subscription?.entity;
    if (!sub) return res.status(200).json({ received: true });
    const dbUser = await getUserBySub(sub.id);

    if (dbUser) {
      await supabase
        .from('users')
        .update({ tier: 'free', sub_status: 'cancelled', sub_expiry: null })
        .eq('id', dbUser.id);
    }
  }

  // ── payment.captured: legacy one-time order (backward compat) ──
  else if (event === 'payment.captured') {
    const payment = payload?.payment?.entity;
    if (!payment) return res.status(200).json({ received: true });

    const { data: pmtRecord } = await supabase
      .from('payments')
      .select('user_id, plan')
      .eq('razorpay_order_id', payment.order_id)
      .maybeSingle();

    if (pmtRecord) {
      const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
      await supabase
        .from('payments')
        .update({ razorpay_payment_id: payment.id, status: 'captured' })
        .eq('razorpay_order_id', payment.order_id);
      await supabase
        .from('users')
        .update({ tier: pmtRecord.plan, sub_expiry: periodEnd })
        .eq('id', pmtRecord.user_id);
    }
  }

  return res.status(200).json({ received: true });
}
