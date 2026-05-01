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
    .select('id, tier, sub_expiry, sub_status, sub_plan, sub_billing')
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

  // ── subscription.charged: renewal succeeded (including retried payments) ─
  // This fires on EVERY successful charge — first month, renewals, AND retries.
  // If user was downgraded to free during a halted period, we restore their tier here.
  else if (event === 'subscription.charged') {
    const sub = payload?.subscription?.entity;
    if (!sub) return res.status(200).json({ received: true });

    const periodEnd = toISO(sub.current_end);
    const dbUser    = await getUserBySub(sub.id);

    if (dbUser) {
      // Determine the correct plan to restore
      // Priority: sub.notes.plan (set at subscription creation) → dbUser.sub_plan → infer from current tier
      const planToRestore = sub.notes?.plan || dbUser.sub_plan || (dbUser.tier !== 'free' ? dbUser.tier : 'pro');

      // Always restore tier + mark active + update expiry on any successful charge
      // This covers: normal renewals, retried payments after bank failure, halted→recovered
      await supabase.from('users')
        .update({
          tier:       planToRestore,
          sub_status: 'active',
          sub_expiry: periodEnd,
        })
        .eq('id', dbUser.id);

      console.log(`[CogniSwift] subscription.charged: restored ${planToRestore} for user ${dbUser.id}, expires ${periodEnd}`);
    }
  }

  // ── subscription.halted: payment failed after all retries ────────────────
  // Razorpay retries 3 times over ~3 days before firing this event.
  // We only downgrade AFTER all retries are exhausted (i.e. this event fires).
  // Individual retry attempts fire payment.failed — we do NOT downgrade on those.
  else if (event === 'subscription.halted') {
    const sub    = payload?.subscription?.entity;
    if (!sub) return res.status(200).json({ received: true });
    const dbUser = await getUserBySub(sub.id);
    if (dbUser) {
      await supabase.from('users')
        .update({ tier: 'free', sub_status: 'halted', sub_expiry: null })
        .eq('id', dbUser.id);

      console.log(`[CogniSwift] subscription.halted: downgraded user ${dbUser.id} to free`);
    }
  }

  // ── payment.failed: a single retry attempt failed ────────────────────────
  // Do NOT downgrade here. Razorpay will retry again.
  // We only downgrade when subscription.halted fires (all retries exhausted).
  else if (event === 'payment.failed') {
    const payment = payload?.payment?.entity;
    const subId   = payment?.subscription_id;

    if (subId) {
      const dbUser = await getUserBySub(subId);
      if (dbUser) {
        // Only update status to show payment is being retried — do NOT change tier
        // sub_status 'retry' tells frontend payment is retrying but access continues
        await supabase.from('users')
          .update({ sub_status: 'retry' })
          .eq('id', dbUser.id);

        console.log(`[CogniSwift] payment.failed (retry in progress): user ${dbUser.id} keeps tier ${dbUser.tier}`);
      }
    }
  }

  // ── subscription.cancelled / completed ───────────────────────────────────
  else if (event === 'subscription.cancelled' || event === 'subscription.completed') {
    const sub    = payload?.subscription?.entity;
    if (!sub) return res.status(200).json({ received: true });
    const dbUser = await getUserBySub(sub.id);
    if (dbUser) {
      const expiry     = dbUser.sub_expiry ? new Date(dbUser.sub_expiry) : null;
      const stillValid = expiry && expiry.getTime() > Date.now();

      if (stillValid) {
        // Paid period not over yet — keep tier, just mark as pending cancel
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
        .update({ tier: pmtRecord.plan, sub_status: 'active', sub_expiry: periodEnd })
        .eq('id', pmtRecord.user_id);
    }
  }

  return res.status(200).json({ received: true });
}
