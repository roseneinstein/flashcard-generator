import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Delete all data for a daily trial user who did not upgrade
async function deleteDailyUserData(userId) {
  console.log(`[CogniSwift] Deleting expired daily trial data for user ${userId}`);
  try {
    // Delete in dependency order (child tables first)
    await supabase.from('card_reviews').delete().eq('user_id', userId);
    await supabase.from('mistakes').delete().eq('user_id', userId);
    await supabase.from('quiz_history').delete().eq('user_id', userId);
    await supabase.from('sets').delete().eq('user_id', userId);
    await supabase.from('payments')
      .delete()
      .eq('user_id', userId)
      .eq('status', 'captured'); // only delete daily payment records, keep failed ones for audit
    // Reset user row to clean free state
    await supabase.from('users').update({
      tier:        'free',
      sub_status:  null,
      sub_expiry:  null,
      sub_billing: null,
      sub_plan:    null,
      sub_id:      null,
      daily_count: 0,
      count_date:  null,
      fsrs_settings: null,
    }).eq('id', userId);

    console.log(`[CogniSwift] Daily trial data deleted for user ${userId}`);
  } catch (err) {
    console.error(`[CogniSwift] Error deleting daily trial data for user ${userId}:`, err.message);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { access_token } = req.body;
  if (!access_token) return res.status(400).json({ error: 'Missing token' });

  const { data: { user }, error } = await supabase.auth.getUser(access_token);
  if (error || !user) return res.status(401).json({ error: 'Invalid or expired token' });

  // Upsert user row
  const { data, error: dbErr } = await supabase
    .from('users')
    .upsert(
      { id: user.id, email: user.email },
      { onConflict: 'id', ignoreDuplicates: false }
    )
    .select('tier, sub_expiry, sub_status, sub_billing, sub_plan')
    .single();

  if (dbErr) return res.status(500).json({ error: dbErr.message });

  let tier       = data?.tier        || 'free';
  let subExpiry  = data?.sub_expiry  || null;
  let subStatus  = data?.sub_status  || null;
  let subBilling = data?.sub_billing || null;
  let subPlan    = data?.sub_plan    || null;

  const now = Date.now();

  // ── DAILY TRIAL EXPIRY CHECK ─────────────────────────────────────────────
  if (subBilling === 'daily' && subExpiry) {
    const expiryTime = new Date(subExpiry).getTime();

    if (now > expiryTime) {
      // Daily trial has expired — check if user upgraded to a paid subscription
      // A paid subscription would have sub_billing = 'monthly' or 'annual'
      // AND sub_status = 'active'. If they upgraded, sub_billing would have changed.
      // Since we're here, sub_billing is still 'daily' → they did NOT upgrade.
      // Delete all their data and reset to free.
      await deleteDailyUserData(user.id);

      tier       = 'free';
      subExpiry  = null;
      subStatus  = null;
      subBilling = null;
      subPlan    = null;
    }
    // If not expired yet — daily trial is still active, serve normally
  }

  // ── REGULAR SUBSCRIPTION EXPIRY CHECK ───────────────────────────────────
  else if (tier !== 'free' && subBilling !== 'daily' && subExpiry) {
    if (now > new Date(subExpiry).getTime()) {
      await supabase
        .from('users')
        .update({ tier: 'free', sub_expiry: null, sub_status: 'expired' })
        .eq('id', user.id);
      tier      = 'free';
      subExpiry = null;
      subStatus = 'expired';
    }
  }

  // Compute days_left for display (works for daily, monthly, annual)
  let daysLeft = null;
  if (subExpiry && tier !== 'free') {
    const msLeft = new Date(subExpiry).getTime() - now;
    daysLeft = Math.max(0, Math.ceil(msLeft / (1000 * 60 * 60 * 24)));
  }

  return res.status(200).json({
    id:          user.id,
    email:       user.email,
    tier,
    sub_expiry:  subExpiry,
    sub_status:  subStatus,
    sub_billing: subBilling,
    sub_plan:    subPlan,
    days_left:   daysLeft,
    avatar:      user.user_metadata?.avatar_url || null,
    name:        user.user_metadata?.full_name  || user.email,
  });
}
