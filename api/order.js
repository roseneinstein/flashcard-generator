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

  const { plan, access_token } = req.body;
  if (!plan || !access_token) return res.status(400).json({ error: 'Missing plan or token' });

  // Verify user is logged in
  const { data: { user }, error: authErr } = await supabase.auth.getUser(access_token);
  if (authErr || !user) return res.status(401).json({ error: 'Not authenticated — please sign in again' });

  const amount = plan === 'pro' ? 9900 : 19900; // in paise (₹99 or ₹199)

  try {
    const order = await razorpay.orders.create({
      amount,
      currency: 'INR',
      receipt: `cs_${user.id.slice(0, 8)}_${Date.now()}`,
      notes: { user_id: user.id, plan },
    });

    // Log payment intent in DB
    await supabase.from('payments').insert({
      user_id:           user.id,
      razorpay_order_id: order.id,
      plan,
      amount,
      status: 'created',
    });

    return res.status(200).json({
      order_id: order.id,
      amount,
      currency: 'INR',
      key_id:   process.env.RAZORPAY_KEY_ID,
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
