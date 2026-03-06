export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, count } = req.body;
  if (!text || !count) return res.status(400).json({ error: 'Missing text or count' });

  const apiKey  = process.env.GROQ_API_KEY;
  const apiKey2 = process.env.GROQ_API_KEY_2;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  // Send up to 8000 chars — enough for 3 full newspaper editorials
  const inputText = text.substring(0, 8000);
  const wordCount = inputText.split(/\s+/).filter(Boolean).length;

  // Decide max quiz questions based on actual word count — done server-side
  // so the AI doesn't have to guess. AI just generates this many Qs.
  let maxQuiz, suggestedCounts;
  if (wordCount < 350) {
    maxQuiz = 5;  suggestedCounts = [5];
  } else if (wordCount < 800) {
    maxQuiz = 10; suggestedCounts = [5, 10];
  } else {
    maxQuiz = 15; suggestedCounts = [5, 10, 15];
  }

  const prompt = `You are a subject-matter expert creating high-quality revision flashcards for serious Indian competitive exam students (UPSC, JEE, NEET, CA, etc.).

The study notes below may cover MULTIPLE topics or editorials. You must cover ALL of them — do NOT focus only on the first topic. Distribute the ${count} flashcards proportionally across every topic present in the notes.

Read carefully and extract specific, exam-relevant facts — not vague summaries.

Return ONLY a valid JSON object. No markdown, no code fences, nothing else.

Schema:
{"flashcards":[{"topic":"string","points":"string"}],"quiz":[{"question":"string","options":["string","string","string","string"],"correct":0,"explanation":"string"}]}

FLASHCARD RULES:

topic:
- Draw the topic name DIRECTLY from the content. Cover all topics present — if there are 3 editorials, cards must come from all 3.
- Every card must have a DISTINCT topic name. If one concept genuinely needs two cards, append Roman numerals: "Topic (I)", "Topic (II)". Use Roman numerals ONLY for this — not for variety.
- Topics must be specific — NOT "Introduction" or "Overview". Use the actual concept, article, or term name.

points (4-6 per card, pipe-separated " | "):
- Each point must state a SPECIFIC fact, figure, date, name, formula, provision, case name, or mechanism from the notes.
- BAD: "It plays an important role" — NEVER write this.
- GOOD: "Article 44 of DPSP directs the state to secure a Uniform Civil Code for all citizens."
- Include exact numbers, percentages, years, chemical symbols, statutory references.
- Preserve ALL technical terms, abbreviations, jargon exactly as in the source.
- Match the register of the source: legal stays formal, science stays precise, history stays factual with dates.

QUIZ RULES:
- Generate exactly ${maxQuiz} quiz questions.
- Cover ALL topics in the notes — not just the first one.
- Test specific facts from the notes only, not general knowledge.
- Distractors must be plausible alternatives from the same domain.
- Explanation must state why the correct answer is right AND why the main wrong option is wrong.

JSON FORMAT (violations break the parser — follow exactly):
1. flashcards array: exactly ${count} objects.
2. quiz array: exactly ${maxQuiz} objects.
3. Every string value on ONE line — no newlines or tabs inside any string.
4. Points separated by " | " (space pipe space).
5. NO double-quote characters inside any string value — rephrase instead.
6. NO trailing commas anywhere.
7. All JSON keys double-quoted. No single quotes anywhere.
8. "correct" is an integer 0-3, not a string.

Study notes:
${inputText}`;

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

  function deduplicateTopics(flashcards) {
    const seen = {};
    return flashcards.map(card => {
      const base = (card.topic || '').replace(/\s*\(I+V?X?\)$/i, '').trim();
      seen[base] = (seen[base] || 0) + 1;
      return { ...card, _base: base, _n: seen[base] };
    }).map(card => {
      const topic = seen[card._base] > 1
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
          max_tokens: 4000,
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
      if (!Array.isArray(parsed.flashcards) || !Array.isArray(parsed.quiz) || !parsed.quiz.length) {
        lastError = 'Response shape invalid'; continue;
      }

      parsed.flashcards = deduplicateTopics(parsed.flashcards);
      // Always use server-computed suggested counts — don't trust AI for this
      parsed.suggested_quiz_counts = suggestedCounts;
      // Trim quiz to maxQuiz in case model over-generated
      parsed.quiz = parsed.quiz.slice(0, maxQuiz);

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
