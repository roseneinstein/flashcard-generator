// regen-card.js
// Regenerates a single flashcard on the same topic with fresh points.
// Routing:
//   Free user or plain text → Groq
//   Pro/Elite user          → Grok 4.1 Fast via OpenRouter (better accuracy)

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, topic, existing_points, access_token } = req.body;
  if (!text || !topic) return res.status(400).json({ error: 'Missing text or topic' });

  // ── Determine user tier ──────────────────────────────────────────────────
  let tier = 'free';
  if (access_token) {
    try {
      const { data: { user }, error } = await supabase.auth.getUser(access_token);
      if (!error && user) {
        const { data: dbUser } = await supabase
          .from('users')
          .select('tier, sub_expiry')
          .eq('id', user.id)
          .single();
        if (dbUser?.tier && dbUser.tier !== 'free') {
          const expiry = dbUser.sub_expiry ? new Date(dbUser.sub_expiry) : null;
          if (!expiry || expiry.getTime() > Date.now()) {
            tier = dbUser.tier;
          }
        }
      }
    } catch (_) {
      // Fall back to free on any error
    }
  }

  const inputText = text.substring(0, 6000);

  const basePrompt = (modelType) => `You are a subject-matter expert creating revision flashcards for Indian competitive exam students.

A student wants a FRESH version of one flashcard. The topic is fixed — you must NOT change it. The points must be DIFFERENT from the existing ones — cover other facts, details, or angles on the same topic from the source text.

${modelType === 'grok' ? `Preserve all technical terms, jargon, formulas, and domain-specific vocabulary exactly as they appear in the source. Include specific figures, dates, percentages, and named references.` : ''}

TOPIC (do not change): "${topic}"

EXISTING POINTS (do not repeat these):
${existing_points || 'None'}

SOURCE TEXT (extract new points only from this):
${inputText}

Return ONLY a valid JSON object — no markdown, no explanation:
{"topic":"${topic}","points":"point 1 | point 2 | point 3 | point 4"}

RULES:
- Keep the exact same topic string
- Write 4–6 points, pipe-separated " | "
- Each point must be a SPECIFIC fact, figure, date, name, formula, or provision from the source text
- Do NOT repeat any point from the existing points above
- If the source text has no more distinct facts on this topic, rephrase the most important existing ones completely
- Every string on ONE line — no newlines inside any string
- NO double-quote characters inside string values`;

  // ── PAID PATH: Grok 4.1 Fast ─────────────────────────────────────────────
  if (tier === 'pro' || tier === 'elite') {
    try {
      const openRouterKey = process.env.OPENROUTER_API_KEY;
      if (!openRouterKey) throw new Error('OpenRouter key not configured');

      const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${openRouterKey}`,
          'HTTP-Referer': 'https://cogniswift.in',
          'X-Title': 'CogniSwift',
        },
        body: JSON.stringify({
          model: 'x-ai/grok-4-1-fast',
          max_tokens: 600,
          temperature: 0.3,
          messages: [
            { role: 'user', content: basePrompt('grok') },
          ],
        }),
      });

      const data = await response.json();
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

      let raw = (data.choices?.[0]?.message?.content || '').trim();
      raw = raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim();
      const fi = raw.indexOf('{'), la = raw.lastIndexOf('}');
      if (fi === -1 || la === -1) throw new Error('No JSON in Grok response');
      raw = raw.slice(fi, la + 1).replace(/[\r\n\t]+/g,' ').replace(/,\s*([}\]])/g,'$1');

      const parsed = JSON.parse(raw);
      if (!parsed.topic || !parsed.points) throw new Error('Bad response shape from Grok');

      return res.status(200).json({ topic: parsed.topic, points: parsed.points });

    } catch (err) {
      console.error('Grok regen error, falling back to Groq:', err.message);
      // Fall through to Groq below
    }
  }

  // ── FREE PATH (or fallback): Groq ────────────────────────────────────────
  const apiKey  = process.env.GROQ_API_KEY;
  const apiKey2 = process.env.GROQ_API_KEY_2;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const attempts = [
    { key: apiKey,  model: 'llama-3.3-70b-versatile' },
    { key: apiKey,  model: 'llama-3.1-8b-instant'    },
    { key: apiKey,  model: 'gemma2-9b-it'             },
    ...(apiKey2 ? [
      { key: apiKey2, model: 'llama-3.3-70b-versatile' },
      { key: apiKey2, model: 'llama-3.1-8b-instant'    },
    ] : []),
  ];

  function isRateLimit(status, errObj) {
    if (status === 429 || status === 413) return true;
    if (!errObj) return false;
    const msg = (errObj.message || '').toLowerCase();
    return msg.includes('rate') || msg.includes('limit') || msg.includes('quota') || msg.includes('try again');
  }

  let lastError = 'All models exhausted';

  for (const { key, model } of attempts) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({
          model,
          max_tokens: 500,
          temperature: 0.3,
          messages: [{ role: 'user', content: basePrompt('groq') }],
          response_format: { type: 'json_object' },
        }),
      });

      const data = await r.json();
      if (data.error) {
        lastError = data.error.message || JSON.stringify(data.error);
        if (isRateLimit(r.status, data.error)) continue;
        continue;
      }

      let raw = (data.choices?.[0]?.message?.content || '').trim();
      raw = raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim();
      const fi = raw.indexOf('{'), la = raw.lastIndexOf('}');
      if (fi === -1 || la === -1) { lastError = 'No JSON'; continue; }
      raw = raw.slice(fi, la + 1).replace(/[\r\n\t]+/g,' ').replace(/,\s*([}\]])/g,'$1');

      const parsed = JSON.parse(raw);
      if (!parsed.topic || !parsed.points) { lastError = 'Bad shape'; continue; }

      return res.status(200).json({ topic: parsed.topic, points: parsed.points });

    } catch (err) {
      lastError = err.message || 'Unknown';
      continue;
    }
  }

  return res.status(503).json({ error: 'Could not regenerate card right now. Try again shortly.' });
}
