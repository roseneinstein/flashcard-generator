export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, depth } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing text' });

  const apiKey  = process.env.GROQ_API_KEY;
  const apiKey2 = process.env.GROQ_API_KEY_2;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const depthInstructions = {
    concise:      'Write a CONCISE summary. 3-4 sections, 2-3 points each. Only the most important facts.',
    standard:     'Write a STANDARD summary. 4-6 sections, 3-5 points each. Balance coverage and brevity.',
    detailed:     'Write a DETAILED summary. 5-7 sections, 4-6 points each. Include facts, context, and mechanisms.',
    'deep dive':  'Write a DETAILED summary. 6-8 sections, 5-7 points each. Cover every sub-topic and key term.',
  };
  const depthNote = depthInstructions[depth] || depthInstructions['standard'];

  // 8,000 chars ~ 2,000 tokens of input. Groq fast models handle ~6k token context.
  // Prompt overhead ~400 tokens + 1,500 output = ~3,900 total — well within limits.
  const safeText = text.substring(0, 8000);

  const prompt = `You are a study notes writer for Indian competitive exams (UPSC, JEE, NEET, CA).

${depthNote}

Return ONLY valid JSON, no markdown, no code fences.
Schema: {"title":"string","sections":[{"heading":"string","points":["string"]}]}

Rules:
- title: max 8 words
- heading: 3-6 words per section
- Each point: one complete fact with specific details from the text
- No double-quotes inside strings (rephrase instead)
- No trailing commas

Study material:
${safeText}`;

  // Fast models first (high TPM) then capable models
  const attempts = [
    { key: apiKey,  model: 'llama-3.1-8b-instant'    },
    { key: apiKey,  model: 'gemma2-9b-it'             },
    { key: apiKey,  model: 'llama-3.3-70b-versatile'  },
    ...(apiKey2 ? [
      { key: apiKey2, model: 'llama-3.1-8b-instant'   },
      { key: apiKey2, model: 'gemma2-9b-it'            },
      { key: apiKey2, model: 'llama-3.3-70b-versatile' },
    ] : []),
  ];

  let lastError = 'All models exhausted';

  for (const { key, model } of attempts) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({
          model,
          max_tokens: 1500,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          response_format: { type: 'json_object' },
        }),
      });

      const data = await r.json();

      if (data.error) {
        lastError = data.error.message || JSON.stringify(data.error);
        // Rate limit or context error → try next model
        continue;
      }

      let raw = (data.choices?.[0]?.message?.content || '').trim();
      raw = raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim();
      const fi = raw.indexOf('{'), la = raw.lastIndexOf('}');
      if (fi === -1 || la === -1) { lastError = 'No JSON in response'; continue; }
      raw = raw.slice(fi, la + 1).replace(/[\r\n\t]+/g,' ').replace(/,\s*([}\]])/g,'$1');

      const parsed = JSON.parse(raw);
      if (!parsed.title || !Array.isArray(parsed.sections)) { lastError = 'Unexpected JSON shape'; continue; }

      return res.status(200).json(parsed);
    } catch (err) {
      lastError = err.message || 'Unknown error';
      continue;
    }
  }

  return res.status(503).json({ error: `Summary unavailable: ${lastError}` });
}
