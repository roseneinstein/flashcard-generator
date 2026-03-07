export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, depth } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing text' });

  const apiKey  = process.env.GROQ_API_KEY;
  const apiKey2 = process.env.GROQ_API_KEY_2;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  // Depth-specific instructions
  const depthInstructions = {
    concise:   'Write a CONCISE summary. Limit to 3-4 sections. Each section has 2-3 sharp, high-density points. Strip all redundancy — only the most important facts survive.',
    standard:  'Write a STANDARD summary. Use 4-6 sections, each with 3-5 points. Balance coverage and brevity.',
    detailed:  'Write a DETAILED summary. Use 5-8 sections, each with 4-7 points. Include supporting facts, context, dates, figures, and mechanisms. Nothing important should be omitted.',
    'deep dive': 'Write an EXHAUSTIVE deep dive. Use 6-10 sections, each with 5-8 points. Cover every sub-topic, nuance, case reference, formula, provision, and example present in the text. This is a full study document, not a quick review.',
  };
  const depthNote = depthInstructions[depth] || depthInstructions['standard'];

  const prompt = `You are an expert study notes writer for Indian competitive exams (UPSC, JEE, NEET, CA).

Read ALL of the study material below. It may cover multiple topics or editorials — your summary MUST cover every topic present, not just the first one. Distribute sections proportionally across all topics.

DEPTH INSTRUCTION: ${depthNote}

Return ONLY a valid JSON object. No markdown, no code fences, nothing else.

Schema:
{"title":"string","sections":[{"heading":"string","points":["string","string"]}]}

RULES:
1. "title" — a short descriptive title for the overall topic (max 8 words).
2. Each section has a "heading" (3-6 words) and "points" array.
3. Each point must be a complete, self-contained fact or explanation. Include specific figures, dates, names, technical terms wherever present in the source text.
4. Do NOT omit technical jargon, key terms, or domain-specific vocabulary.
5. Every string must be on ONE line. No newlines or tabs inside any string.
6. Do NOT use double-quote characters inside string values. Rephrase instead.
7. NO trailing commas. All keys double-quoted. No single quotes.

Study material:
${text}`;

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
    const msg = (errObj.message || '').toLowerCase();
    return msg.includes('rate') || msg.includes('limit') || msg.includes('quota') || msg.includes('try again');
  }

  // Scale tokens with depth
  // Always cap at 2000 — Groq free tier can reject higher values on some models.
  // Depth controls prompt verbosity, not max_tokens.
  const maxTokens = 2000;

  let lastError = 'All models exhausted';

  for (const { key, model } of attempts) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.15,
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
      if (!parsed.title || !Array.isArray(parsed.sections)) { lastError = 'Bad shape'; continue; }

      return res.status(200).json(parsed);
    } catch (err) {
      lastError = err.message || 'Unknown';
      continue;
    }
  }

  return res.status(503).json({ error: 'All models at limit. Try again shortly.' });
}
