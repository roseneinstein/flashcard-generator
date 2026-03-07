export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, depth } = req.body;
  if (!text) return res.status(400).json({ error: 'Missing text' });

  const apiKey  = process.env.GROQ_API_KEY;
  const apiKey2 = process.env.GROQ_API_KEY_2;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const depthInstructions = {
    concise:     'Write a CONCISE summary: 3-4 sections, 2-3 bullet points each.',
    standard:    'Write a STANDARD summary: 4-6 sections, 3-5 bullet points each.',
    detailed:    'Write a DETAILED summary: 5-7 sections, 4-6 bullet points each.',
    'deep dive': 'Write a THOROUGH summary: 6-8 sections, 5-7 bullet points each.',
  };
  const depthNote = depthInstructions[depth] || depthInstructions.standard;

  // Hard cap at 6000 chars (~1500 tokens). Total prompt ~2200 tokens + 1200 output = ~3400.
  // Stays well inside every Groq model's per-request and per-minute token budget.
  const safeText = (text || '').substring(0, 6000);

  const prompt = `You are a study notes writer for Indian exams (UPSC, JEE, NEET, CA). ${depthNote}

Return ONLY a JSON object. No markdown, no backticks. Schema:
{"title":"string","sections":[{"heading":"string","points":["string"]}]}

Rules: title max 8 words. heading 3-6 words. Each point = one complete fact with specific details. No double-quotes inside strings. No trailing commas.

Study material:
${safeText}`;

  // Fast small models first — they have the highest TPM quota on Groq free tier
  const models = [
    'llama-3.1-8b-instant',
    'gemma2-9b-it',
    'llama-3.3-70b-versatile',
  ];

  const keys = [apiKey, ...(apiKey2 ? [apiKey2] : [])];
  const attempts = keys.flatMap(k => models.map(m => ({ key: k, model: m })));

  let errors = [];

  for (const { key, model } of attempts) {
    try {
      const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          max_tokens: 1200,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1,
          response_format: { type: 'json_object' },
        }),
      });

      const data = await r.json();

      if (data.error) {
        errors.push(`${model}: ${data.error.message || data.error.type || JSON.stringify(data.error)}`);
        continue;
      }

      let raw = (data.choices?.[0]?.message?.content || '').trim();
      raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();
      const fi = raw.indexOf('{'), la = raw.lastIndexOf('}');
      if (fi < 0 || la < 0) { errors.push(`${model}: no JSON`); continue; }
      raw = raw.slice(fi, la + 1).replace(/[\r\n\t]+/g, ' ').replace(/,\s*([}\]])/g, '$1');

      const parsed = JSON.parse(raw);
      if (!parsed.title || !Array.isArray(parsed.sections)) { errors.push(`${model}: bad shape`); continue; }

      return res.status(200).json(parsed);
    } catch (err) {
      errors.push(`${model}: ${err.message}`);
      continue;
    }
  }

  // Return all errors so we can actually debug what Groq is saying
  return res.status(503).json({
    error: `Summary failed. Details: ${errors.slice(0, 3).join(' | ')}`,
  });
}
