export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, count } = req.body;
  if (!text || !count) return res.status(400).json({ error: 'Missing text or count' });

  const apiKey  = process.env.GROQ_API_KEY;
  const apiKey2 = process.env.GROQ_API_KEY_2;  // optional second Groq account
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const prompt = `You are a study assistant for Indian competitive exams.

Return ONLY a valid JSON object. Nothing else — no explanation, no markdown, no code fences.

Schema:
{"flashcards":[{"topic":"string","points":"string"}],"quiz":[{"question":"string","options":["string","string","string","string"],"correct":0,"explanation":"string"}]}

RULES:
1. flashcards array must have exactly ${count} objects.
2. quiz array must have exactly 5 objects.
3. Every string value must be on a single line — no newlines or tabs inside strings.
4. In "points", separate items with " | " (space pipe space).
5. Inside any string value: do NOT use double-quote characters. Rephrase instead.
6. NO trailing commas. Last item in every array or object has no comma after it.
7. All keys must be double-quoted. No single quotes anywhere.
8. "correct" must be an integer (0, 1, 2, or 3).

Study notes:
${text.substring(0, 2000)}`;

  // All free Groq models — tried in order, falls back on rate limit
  // Add GROQ_API_KEY_2 in Vercel env vars (different Groq account) for extra capacity
  const attempts = [
    { key: apiKey,  model: 'llama-3.3-70b-versatile' },
    { key: apiKey,  model: 'llama-3.1-8b-instant'    },
    { key: apiKey,  model: 'gemma2-9b-it'             },
    { key: apiKey,  model: 'mixtral-8x7b-32768'       },
    ...(apiKey2 ? [
      { key: apiKey2, model: 'llama-3.3-70b-versatile' },
      { key: apiKey2, model: 'llama-3.1-8b-instant'    },
      { key: apiKey2, model: 'gemma2-9b-it'             },
    ] : []),
  ];

  let lastError = 'All models exhausted';

  for (const { key, model } of attempts) {
    try {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({
          model,
          max_tokens: 3000,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          response_format: { type: 'json_object' },
        }),
      });

      const data = await groqRes.json();

      if (data.error) {
        lastError = data.error.message || JSON.stringify(data.error);
        // Rate / token / quota limits → try next model
        if (groqRes.status === 429 || groqRes.status === 413 ||
            (data.error.code || '').includes('rate') ||
            (data.error.code || '').includes('token') ||
            (lastError || '').toLowerCase().includes('limit')) {
          continue;
        }
        // Hard error (bad key, model not found, etc.) — stop
        return res.status(500).json({ error: lastError });
      }

      let raw = data.choices[0].message.content.trim();
      // Strip accidental markdown fences
      raw = raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim();
      // Extract outermost { }
      const fi = raw.indexOf('{'), la = raw.lastIndexOf('}');
      if (fi === -1 || la === -1) { lastError = 'No JSON found'; continue; }
      raw = raw.slice(fi, la + 1);
      // Collapse stray whitespace control chars
      raw = raw.replace(/[\r\n\t]+/g, ' ');
      // Trailing comma repair (the one structural issue that slips through)
      raw = raw.replace(/,\s*([}\]])/g, '$1');

      const parsed = JSON.parse(raw);

      if (!Array.isArray(parsed.flashcards) || !Array.isArray(parsed.quiz)) {
        lastError = 'Response shape invalid'; continue;
      }

      return res.status(200).json(parsed);

    } catch (err) {
      lastError = err.message || 'Unknown';
      continue; // network / parse error → next model
    }
  }

  return res.status(503).json({
    error: 'Daily limit reached for today. Please try again tomorrow, or add a second Groq API key (GROQ_API_KEY_2) in Vercel environment variables.',
  });
}
