import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Verify Razorpay webhook signature to ensure request is genuine
  const secret    = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_SECRET;
  const signature = req.headers['x-razorpay-signature'];
  const body      = JSON.stringify(req.body);

  const expected = crypto
    .createHmac('sha256', secret)
    .update(body)
    .digest('hex');

  if (signature !== expected) {
    return res.status(400).json({ error: 'Invalid webhook signature' });
  }

  const event   = req.body.event;
  const payload = req.body.payload?.payment?.entity;

  if (event === 'payment.captured' && payload) {
    const orderId   = payload.order_id;
    const paymentId = payload.id;

    // Find matching payment record
    const { data: payment } = await supabase
      .from('payments')
      .select('user_id, plan')
      .eq('razorpay_order_id', orderId)
      .single();

    if (payment) {
      // Mark payment as captured
      await supabase
        .from('payments')
        .update({ razorpay_payment_id: paymentId, status: 'captured' })
        .eq('razorpay_order_id', orderId);

      // Upgrade user tier in DB
      await supabase
        .from('users')
        .update({ tier: payment.plan })
        .eq('id', payment.user_id);
    }
  }

  return res.status(200).json({ received: true });
}
