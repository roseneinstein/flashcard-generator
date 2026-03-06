// Regenerates a single card on the SAME topic but with fresh, different points
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, topic, existing_points } = req.body;
  if (!text || !topic) return res.status(400).json({ error: 'Missing text or topic' });

  const apiKey  = process.env.GROQ_API_KEY;
  const apiKey2 = process.env.GROQ_API_KEY_2;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const prompt = `You are a subject-matter expert creating revision flashcards for Indian competitive exam students.

A student wants a FRESH version of one flashcard. The topic is fixed — you must NOT change it. But the points must be DIFFERENT from the existing ones — cover other facts, details, or angles on the same topic from the source text.

TOPIC (do not change): "${topic}"

EXISTING POINTS (do not repeat these):
${existing_points}

SOURCE TEXT (extract new points only from this):
${text.substring(0, 6000)}

Return ONLY a valid JSON object — no markdown, no explanation:
{"topic":"${topic}","points":"point 1 | point 2 | point 3 | point 4"}

RULES:
- Keep the exact same topic string
- Write 4–6 points, pipe-separated
- Each point must be a SPECIFIC fact, figure, date, name, formula, or provision from the source text
- Do NOT repeat any point from the existing points above
- If the source text has no more distinct facts on this topic, pick the most important existing ones but rephrase them completely
- Every string on ONE line — no newlines inside any string`;

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
          messages: [{ role: 'user', content: prompt }],
          response_format: { type: 'json_object' },
        }),
      });

      const data = await r.json();
      if (data.error) {
        lastError = data.error.message || JSON.stringify(data.error);
        if (isRateLimit(r.status, data.error)) continue;
        continue;
      }

      let raw = data.choices[0].message.content.trim();
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
