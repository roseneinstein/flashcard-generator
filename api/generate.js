export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, count } = req.body;
  if (!text || !count) return res.status(400).json({ error: 'Missing text or count' });

  const apiKey  = process.env.GROQ_API_KEY;
  const apiKey2 = process.env.GROQ_API_KEY_2;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const prompt = `You are a subject-matter expert creating high-quality revision flashcards for serious Indian competitive exam students (UPSC, JEE, NEET, CA, etc.).

Read the study notes carefully. Extract specific, exam-relevant facts — not vague summaries.

Return ONLY a valid JSON object. No markdown, no code fences, nothing else.

Schema:
{"flashcards":[{"topic":"string","points":"string"}],"quiz":[{"question":"string","options":["string","string","string","string"],"correct":0,"explanation":"string"}]}

FLASHCARD RULES — read carefully:

topic:
- Draw the topic name DIRECTLY from the content — use the actual term, article, concept, or sub-heading from the notes.
- Every card must have a DISTINCT topic name. If the source genuinely needs two cards on the same concept (too much detail for one), append Roman numerals: "Osmosis (I)", "Osmosis (II)". Use Roman numerals ONLY in this case — not for variety.
- Topics must be specific: NOT "Introduction" or "Overview" or "Key Points" — use the actual concept name.

points (4–6 per card, pipe-separated):
- Each point must state a SPECIFIC fact, definition, figure, date, name, formula, provision, or mechanism directly from the notes.
- BAD (too generic): "It plays an important role in governance" — NEVER write this.
- GOOD (specific): "Article 44 of DPSP directs the state to secure a Uniform Civil Code for citizens across India."
- Include exact numbers, percentages, years, chemical symbols, statutory references, case names, unit values — whatever is in the source.
- Preserve ALL technical terms, abbreviations, and domain jargon exactly as written in the source.
- Match the register of the source: legal text stays formal, science stays precise, history stays factual with dates.
- If the source contains Hindi transliterations, acronyms, or Latin terms — keep them verbatim in the relevant card.

QUIZ RULES:
- Test specific facts from the notes only — not general knowledge.
- Distractors must be plausible alternatives from the same domain.
- Explanation must state why the correct answer is right AND why the main wrong option is wrong.

JSON FORMAT (violations break the parser):
1. flashcards array: exactly ${count} objects.
2. quiz array: exactly 5 objects.
3. Every string value on ONE line — no newlines or tabs inside strings.
4. Points separated by " | " (space pipe space).
5. NO double-quote characters inside any string value — rephrase instead.
6. NO trailing commas. Last item in every array/object has no comma after it.
7. All JSON keys double-quoted. No single quotes anywhere.
8. "correct" is an integer 0–3.

Study notes:
${text.substring(0, 3500)}`;

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
    return msg.includes('rate')  || msg.includes('limit') || msg.includes('quota') ||
           msg.includes('tpd')   || msg.includes('tokens per day') || msg.includes('try again') ||
           code.includes('rate') || code.includes('limit') || code.includes('quota');
  }

  // Post-process: add Roman numerals to duplicate topic names
  function deduplicateTopics(flashcards) {
    const seen = {};
    return flashcards.map(function(card) {
      const base = (card.topic || '').replace(/\s*\(I+V?X?\)$/i, '').trim();
      seen[base] = (seen[base] || 0) + 1;
      return { ...card, _base: base, _n: seen[base] };
    }).map(function(card) {
      const total = seen[card._base];
      const topic = total > 1
        ? card._base + ' (' + toRoman(card._n) + ')'
        : card._base;
      return { topic, points: card.points };
    });
  }

  function toRoman(n) {
    const map = [[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']];
    let r = '';
    for (const [v, s] of map) { while (n >= v) { r += s; n -= v; } }
    return r;
  }

  let lastError = 'All models exhausted';

  for (const { key, model } of attempts) {
    try {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({
          model,
          max_tokens: 3500,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.15,
          response_format: { type: 'json_object' },
        }),
      });

      const data = await groqRes.json();
      if (data.error) {
        lastError = data.error.message || JSON.stringify(data.error);
        if (isRateLimit(groqRes.status, data.error)) continue;
        if (groqRes.status === 401 || groqRes.status === 403)
          return res.status(500).json({ error: 'Invalid API key — check Vercel env vars' });
        continue;
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

      parsed.flashcards = deduplicateTopics(parsed.flashcards);
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
