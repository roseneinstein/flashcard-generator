export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, count } = req.body;
  if (!text || !count) return res.status(400).json({ error: 'Missing text or count' });

  const apiKey  = process.env.GROQ_API_KEY;
  const apiKey2 = process.env.GROQ_API_KEY_2;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const inputText = text.substring(0, 12000);
  const wordCount = inputText.split(/\s+/).filter(Boolean).length;

  // Detect if text is primarily Hindi (Devanagari Unicode range 0900–097F)
  const devanagariChars = (inputText.match(/[\u0900-\u097F]/g) || []).length;
  const totalLetters    = (inputText.match(/[a-zA-Z\u0900-\u097F]/g) || []).length;
  const isHindi = totalLetters > 0 && (devanagariChars / totalLetters) > 0.4;

  const langInstruction = isHindi
    ? `LANGUAGE RULE — CRITICAL: The source text is primarily in Hindi. You MUST write ALL output — every topic name, every point, every quiz question, every option, every explanation — entirely in Hindi (Devanagari script). Do NOT switch to English at any point, even for technical terms (transliterate them into Devanagari if needed).`
    : `LANGUAGE RULE: Write all output in the same language as the source text.`;

  // Always generate maximum quiz questions — frontend slices to user's selection
  const maxQuiz = wordCount < 400 ? 5 : wordCount < 900 ? 10 : 20;

  const countNote = count > 15
    ? `CRITICAL: You MUST return EXACTLY ${count} flashcard objects. Count them before responding. Not ${count-2}, not ${count+2} — exactly ${count}.`
    : `Return exactly ${count} flashcard objects.`;

  const prompt = `You are a subject-matter expert creating high-quality revision flashcards for serious Indian competitive exam students (UPSC, JEE, NEET, CA, etc.).

${langInstruction}

The study notes below may cover MULTIPLE topics or editorials. You must cover ALL of them — do NOT focus only on the first topic. Distribute the ${count} flashcards proportionally across every topic present in the notes.

Return ONLY a valid JSON object. No markdown, no code fences, nothing else.

Schema:
{"flashcards":[{"topic":"string","points":"string"}],"quiz":[{"question":"string","options":["string","string","string","string"],"correct":0,"explanation":"string"}]}

FLASHCARD RULES:

topic:
- Draw the topic name DIRECTLY from the content. Cover all topics present.
- Every card must have a DISTINCT topic name. If one concept needs two cards, append Roman numerals: "Topic (I)", "Topic (II)".
- Topics must be specific — NOT "Introduction" or "Overview".

points (4-6 per card, pipe-separated " | "):
- Each point must state a SPECIFIC fact, figure, date, name, formula, provision, or mechanism from the notes.
- BAD: "It plays an important role" — NEVER write this.
- GOOD: "Article 44 of DPSP directs the state to secure a Uniform Civil Code."
- Include exact numbers, percentages, years, chemical symbols, statutory references.
- Preserve ALL technical terms exactly as in the source.

QUIZ RULES — CRITICAL:
- Generate EXACTLY ${maxQuiz} quiz questions. This is a hard requirement — count them before outputting.
- Cover ALL topics in the notes proportionally.
- Test specific facts from the notes only.
- Distractors must be plausible alternatives from the same domain.
- Explanation: why the correct answer is right AND why the main wrong option is wrong.

JSON FORMAT:
1. ${countNote}
2. quiz array: EXACTLY ${maxQuiz} objects — count before outputting.
3. Every string on ONE line — no newlines or tabs inside strings.
4. Points separated by " | " (space pipe space).
5. NO double-quote characters inside string values.
6. NO trailing commas.
7. All keys double-quoted. No single quotes.
8. "correct" is integer 0-3.

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
    return msg.includes('rate') || msg.includes('limit') || msg.includes('quota') ||
           msg.includes('tpd')  || msg.includes('try again') ||
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

  function padToCount(cards, target) {
    if (cards.length >= target) return cards.slice(0, target);
    const result = cards.slice();
    let i = 0;
    while (result.length < target) {
      const src = cards[i % cards.length];
      result.push({ topic: src.topic + ' (cont.)', points: src.points });
      i++;
    }
    return result;
  }

  let lastError = 'All models exhausted';

  for (const { key, model } of attempts) {
    try {
      const maxTokens = Math.min(5000, 1500 + count * 80 + maxQuiz * 80);

      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
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
      if (fi === -1 || la === -1) { lastError = 'No JSON found'; continue; }
      raw = raw.slice(fi, la + 1).replace(/[\r\n\t]+/g, ' ').replace(/,\s*([}\]])/g, '$1');

      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed.flashcards) || !Array.isArray(parsed.quiz) || !parsed.quiz.length) {
        lastError = 'Response shape invalid'; continue;
      }

      parsed.flashcards = deduplicateTopics(parsed.flashcards);
      parsed.flashcards = padToCount(parsed.flashcards, count);
      // Keep all quiz questions — frontend will show count options based on length
      // Slice only to maxQuiz cap
      parsed.quiz = parsed.quiz.slice(0, maxQuiz);

      return res.status(200).json(parsed);

    } catch (err) {
      lastError = err.message || 'Unknown';
      continue;
    }
  }

  return res.status(503).json({ error: `All models unavailable: ${lastError}` });
}
