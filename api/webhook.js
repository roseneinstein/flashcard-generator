// Razorpay webhook — handles full subscription lifecycle.
// Configure in Razorpay dashboard → Webhooks → add URL + secret.
// Events: subscription.activated, subscription.charged,
//         subscription.halted, subscription.cancelled, subscription.completed,
//         payment.captured (legacy one-time orders)

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

async function getUserBySub(subId) {
  const { data } = await supabase
    .from('users')
    .select('id, tier, sub_expiry, sub_status')
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

  // ── subscription.activated: first payment done ───────────────────────────
  if (event === 'subscription.activated') {
    const sub = payload?.subscription?.entity;
    if (!sub) return res.status(200).json({ received: true });
    const plan      = sub.notes?.plan || 'pro';
    const periodEnd = toISO(sub.current_end);
    const dbUser    = await getUserBySub(sub.id);
    if (dbUser) {
      await supabase.from('users')
        .update({ tier: plan, sub_status: 'active', sub_expiry: periodEnd })
        .eq('id', dbUser.id);
    }
  }

  // ── subscription.charged: monthly renewal succeeded ──────────────────────
  else if (event === 'subscription.charged') {
    const sub = payload?.subscription?.entity;
    if (!sub) return res.status(200).json({ received: true });
    const periodEnd = toISO(sub.current_end);
    const dbUser    = await getUserBySub(sub.id);
    if (dbUser) {
      await supabase.from('users')
        .update({ sub_status: 'active', sub_expiry: periodEnd })
        .eq('id', dbUser.id);
    }
  }

  // ── subscription.halted: payment failed after all retries ────────────────
  else if (event === 'subscription.halted') {
    const sub    = payload?.subscription?.entity;
    if (!sub) return res.status(200).json({ received: true });
    const dbUser = await getUserBySub(sub.id);
    if (dbUser) {
      await supabase.from('users')
        .update({ tier: 'free', sub_status: 'halted', sub_expiry: null })
        .eq('id', dbUser.id);
    }
  }

  // ── subscription.cancelled / completed ───────────────────────────────────
  // IMPORTANT: if user cancelled via our app (cancel_at_cycle_end=1),
  // Razorpay fires this event AFTER the cycle ends — so sub_expiry has
  // already passed and downgrading to free is correct.
  // If cancelled immediately (e.g. from Razorpay dashboard), we still
  // check sub_expiry before downgrading so user keeps any paid time.
  else if (event === 'subscription.cancelled' || event === 'subscription.completed') {
    const sub    = payload?.subscription?.entity;
    if (!sub) return res.status(200).json({ received: true });
    const dbUser = await getUserBySub(sub.id);
    if (dbUser) {
      const expiry     = dbUser.sub_expiry ? new Date(dbUser.sub_expiry) : null;
      const stillValid = expiry && expiry.getTime() > Date.now();

      if (stillValid) {
        // Paid period not over yet — keep tier, just mark as pending cancel
        // auth.js expiry check will downgrade them when the date passes
        await supabase.from('users')
          .update({ sub_status: 'pending_cancel' })
          .eq('id', dbUser.id);
      } else {
        // Period over — downgrade to free now
        await supabase.from('users')
          .update({ tier: 'free', sub_status: 'cancelled', sub_expiry: null })
          .eq('id', dbUser.id);
      }
    }
  }

  // ── payment.captured: legacy one-time order ──────────────────────────────
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
      await supabase.from('payments')
        .update({ razorpay_payment_id: payment.id, status: 'captured' })
        .eq('razorpay_order_id', payment.order_id);
      await supabase.from('users')
        .update({ tier: pmtRecord.plan, sub_expiry: periodEnd })
        .eq('id', pmtRecord.user_id);
    }
  }

  return res.status(200).json({ received: true });
}
