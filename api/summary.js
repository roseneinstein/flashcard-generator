export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing text' });

  const apiKey  = process.env.GROQ_API_KEY;
  const apiKey2 = process.env.GROQ_API_KEY_2;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const prompt = `You are an expert study notes writer for Indian competitive exams (UPSC, JEE, NEET, CA).

Read the study material below and produce a detailed structured summary.

Return ONLY a valid JSON object. No markdown, no code fences, nothing else.

Schema:
{"title":"string","sections":[{"heading":"string","points":["string","string"]}]}

RULES:
1. "title" — a short descriptive title for the overall topic (max 8 words).
2. "sections" — 4 to 8 sections, each covering a distinct sub-topic or theme from the text.
3. Each section has a "heading" (3-6 words) and "points" — an array of 3-7 strings.
4. Each point in "points" must be a complete, self-contained fact or explanation (not a one-liner heading). Include specific figures, dates, names, technical terms wherever present in the source text.
5. Do NOT omit technical jargon, key terms, or domain-specific vocabulary — include them naturally within the points.
6. Every string must be on ONE line. No newlines or tabs inside any string.
7. Do NOT use double-quote characters inside string values. Rephrase instead.
8. NO trailing commas anywhere.
9. All keys double-quoted. No single quotes.

Study material:
${text.substring(0, 3000)}`;

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
    if (status === 429 || status === 413) return true;
    if (!errObj) return false;
    const msg  = (errObj.message || '').toLowerCase();
    const code = (errObj.code    || '').toLowerCase();
    return msg.includes('rate') || msg.includes('limit') || msg.includes('quota') ||
           msg.includes('tpd')  || msg.includes('tokens per day') || msg.includes('try again') ||
           code.includes('rate')|| code.includes('limit') || code.includes('quota');
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
        if (isRateLimit(groqRes.status, data.error)) continue;
        if (groqRes.status === 401 || groqRes.status === 403)
          return res.status(500).json({ error: 'Invalid API key' });
        continue;
      }

      let raw = data.choices[0].message.content.trim();
      raw = raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim();
      const fi = raw.indexOf('{'), la = raw.lastIndexOf('}');
      if (fi === -1 || la === -1) { lastError = 'No JSON'; continue; }
      raw = raw.slice(fi, la + 1);
      raw = raw.replace(/[\r\n\t]+/g, ' ');
      raw = raw.replace(/,\s*([}\]])/g, '$1');

      const parsed = JSON.parse(raw);
      if (!parsed.title || !Array.isArray(parsed.sections)) {
        lastError = 'Response shape invalid'; continue;
      }
      return res.status(200).json(parsed);

    } catch (err) {
      lastError = err.message || 'Unknown';
      continue;
    }
  }

  return res.status(503).json({ error: 'All models are at their daily limit. Try again in a few hours.' });
}
