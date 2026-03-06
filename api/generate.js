export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, count } = req.body;
  if (!text || !count) return res.status(400).json({ error: 'Missing text or count' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const prompt = `You are a study assistant for Indian competitive exams.

Return ONLY a valid JSON object. Absolutely nothing else — no explanation, no markdown, no code fences.

Use this exact schema:
{"flashcards":[{"topic":"string","points":"string"}],"quiz":[{"question":"string","options":["string","string","string","string"],"correct":0,"explanation":"string"}]}

RULES:
1. flashcards array must have exactly ${count} objects.
2. quiz array must have exactly 5 objects.
3. Every string value must be on a single line — no newlines or tabs inside strings.
4. In "points", separate items with " | " (space pipe space).
5. Inside any string value: do NOT use double-quote characters. Rephrase instead.
6. Inside any string value: do NOT use backslashes.
7. NO trailing commas. The last item in every array or object has no comma after it.
8. All keys must be double-quoted. No single quotes anywhere.
9. "correct" must be an integer (0, 1, 2, or 3) — not a string.

Study notes:
${text.substring(0, 2000)}`;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 3500,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        response_format: { type: 'json_object' },
      }),
    });

    const data = await groqRes.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    let raw = data.choices[0].message.content.trim();

    // Strip any accidental markdown fences
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    // Slice to outermost { }
    const first = raw.indexOf('{');
    const last  = raw.lastIndexOf('}');
    if (first === -1 || last === -1) return res.status(500).json({ error: 'AI did not return JSON' });
    raw = raw.slice(first, last + 1);

    // Collapse real whitespace control chars (newlines/tabs) inside JSON
    raw = raw.replace(/[\r\n\t\x0B\x0C]+/g, ' ');

    // Repair: trailing commas before } or ]
    raw = raw.replace(/,\s*([}\]])/g, '$1');

    // Parse — if this fails, the model sent something structurally broken
    // that we cannot safely auto-repair without corrupting content.
    try {
      const parsed = JSON.parse(raw);

      // Validate shape
      if (!Array.isArray(parsed.flashcards) || !Array.isArray(parsed.quiz)) {
        return res.status(500).json({ error: 'AI response missing flashcards or quiz array' });
      }

      return res.status(200).json(parsed);
    } catch (e) {
      // Return raw snippet to help debug (first 300 chars around error position)
      const pos = parseInt((e.message.match(/position (\d+)/) || [])[1]) || 0;
      const snippet = raw.substring(Math.max(0, pos - 80), pos + 80);
      return res.status(500).json({
        error: 'JSON parse failed: ' + e.message,
        snippet,
      });
    }

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Something went wrong' });
  }
}
