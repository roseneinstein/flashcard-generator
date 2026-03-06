export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, count } = req.body;
  if (!text || !count) return res.status(400).json({ error: 'Missing text or count' });

  const apiKey  = process.env.GROQ_API_KEY;
  const apiKey2 = process.env.GROQ_API_KEY_2;
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

  const attempts = [
    { key: apiKey,  model: 'llama-3.3-70b-versatile' },
    { key: apiKey,  model: 'llama-3.1-8b-instant'    },
    { key: apiKey,  model: 'gemma2-9b-it'             },
    { key: apiKey,  model: 'mixtral-8x7b-32768'       },
    ...(apiKey2 ? [
      { key: apiKey2, model: 'llama-3.3-70b-versatile' },
      { key: apiKey2, model: 'llama-3.1-8b-instant'    },
      { key: apiKey2, model: 'gemma2-9b-it'             },
      { key: apiKey2, model: 'mixtral-8x7b-32768'       },
    ] : []),
  ];

  function isRateLimit(status, errObj) {
    // Catch every form Groq uses to signal quota/rate exhaustion
    if (status === 429 || status === 413) return true;
    if (!errObj) return false;
    const msg  = (errObj.message || '').toLowerCase();
    const code = (errObj.code    || '').toLowerCase();
    const type = (errObj.type    || '').toLowerCase();
    return (
      msg.includes('rate')   || msg.includes('limit')  ||
      msg.includes('quota')  || msg.includes('tpd')    ||
      msg.includes('tokens per day') || msg.includes('try again') ||
      code.includes('rate')  || code.includes('limit') ||
      code.includes('quota') || type.includes('rate')
    );
  }

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
        if (isRateLimit(groqRes.status, data.error)) {
          continue; // try next model/key
        }
        // Only stop on auth errors; everything else retry
        if (groqRes.status === 401 || groqRes.status === 403) {
          return res.status(500).json({ error: 'Invalid API key — check Vercel env vars' });
        }
        continue; // unknown error → still try next
      }

      let raw = data.choices[0].message.content.trim();
      raw = raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim();
      const fi = raw.indexOf('{'), la = raw.lastIndexOf('}');
      if (fi === -1 || la === -1) { lastError = 'No JSON found'; continue; }
      raw = raw.slice(fi, la + 1);
      raw = raw.replace(/[\r\n\t]+/g, ' ');
      raw = raw.replace(/,\s*([}\]])/g, '$1');

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.flashcards) || !Array.isArray(parsed.quiz)) {
        lastError = 'Response shape invalid'; continue;
      }

      return res.status(200).json(parsed);

    } catch (err) {
      lastError = err.message || 'Unknown';
      continue;
    }
  }

  return res.status(503).json({
    error: 'All models are at their daily limit right now. Please try again in a few hours.',
  });
}
