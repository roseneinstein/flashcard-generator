// generate.js
// Routing logic:
//   - User pastes plain text (any tier)  → Groq (free tier models)
//   - Free user uploads PDF/image        → Groq (text extraction only, no vision)
//   - Pro user uploads PDF/image         → Grok 4.1 Fast via OpenRouter (text + tables/graphs/charts)
//   - Elite user uploads PDF/image       → Grok 4.1 Fast via OpenRouter (full vision: handwriting, diagrams, flowcharts, everything)

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── Shared helper functions ───────────────────────────────────────────────

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

function isRateLimitGroq(status, errObj) {
  if (status === 429 || status === 413) return true;
  if (!errObj) return false;
  const msg  = (errObj.message || '').toLowerCase();
  const code = (errObj.code    || '').toLowerCase();
  return msg.includes('rate') || msg.includes('limit') || msg.includes('quota') ||
         msg.includes('tpd')  || msg.includes('try again') ||
         code.includes('rate') || code.includes('limit') || code.includes('quota');
}

function parseAndValidate(raw) {
  raw = raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim();
  const fi = raw.indexOf('{'), la = raw.lastIndexOf('}');
  if (fi === -1 || la === -1) throw new Error('No JSON found');
  raw = raw.slice(fi, la + 1).replace(/[\r\n\t]+/g, ' ').replace(/,\s*([}\]])/g, '$1');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed.flashcards) || !Array.isArray(parsed.quiz) || !parsed.quiz.length) {
    throw new Error('Response shape invalid');
  }
  return parsed;
}

function detectLanguage(inputText) {
  const devanagariChars = (inputText.match(/[\u0900-\u097F]/g) || []).length;
  const totalLetters    = (inputText.match(/[a-zA-Z\u0900-\u097F]/g) || []).length;
  const isHindi = totalLetters > 0 && (devanagariChars / totalLetters) > 0.4;
  return isHindi
    ? `LANGUAGE RULE — CRITICAL: The source text is primarily in Hindi. You MUST write ALL output — every topic name, every point, every quiz question, every option, every explanation — entirely in Hindi (Devanagari script). Do NOT switch to English at any point, even for technical terms (transliterate them into Devanagari if needed).`
    : `LANGUAGE RULE: Write all output in the same language as the source text. Preserve all technical terms, jargon, and domain-specific vocabulary exactly as they appear.`;
}

// ─── SYSTEM PROMPT (static — gets cached by Grok 4.1 on OpenRouter) ────────
// This never changes between requests, maximising prompt cache hits at $0.05/1M tokens.

const GROK_SYSTEM_PROMPT = `You are a world-class subject-matter expert and study material creator specialising in Indian competitive exams: UPSC, JEE, NEET, CA, SSC, GATE, and similar high-stakes examinations.

Your sole job is to analyse the provided study material — which may include text, tables, graphs, charts, handwritten notes, diagrams, and flowcharts — and return a single, perfectly structured JSON object containing flashcards, a quiz, and a summary.

═══════════════════════════════════════════════
SECTION 1 — FLASHCARD RULES
═══════════════════════════════════════════════

TOPIC field:
• Draw the topic name DIRECTLY from the content. Cover ALL topics present — do NOT focus only on the first topic.
• Distribute flashcards PROPORTIONALLY across every topic in the material.
• Every card must have a DISTINCT topic name.
• If one concept genuinely needs two cards, append Roman numerals: "Photosynthesis (I)", "Photosynthesis (II)".
• Topics must be SPECIFIC — NEVER use "Introduction", "Overview", "Miscellaneous".
• Preserve technical terms, chemical names, statutory references, and jargon exactly.

POINTS field (pipe-separated, 4–6 points per card):
• Each point MUST state a SPECIFIC fact, figure, date, name, formula, provision, mechanism, or data value from the material.
• BAD point: "It plays an important role in the economy." — NEVER write this.
• GOOD point: "Article 44 of DPSP directs the state to secure a Uniform Civil Code for citizens."
• Include exact numbers, percentages, years, chemical symbols, units, and statutory references wherever present.
• Preserve ALL technical terms and jargon exactly as in the source.
• From tables: capture row/column relationships as factual statements.
• From graphs/charts: capture trend direction, peak values, comparative figures, axis labels, and units.
• From diagrams/flowcharts: capture the sequence, components, and relationships shown.
• Points separated by " | " (space-pipe-space). No newlines inside the points string.

═══════════════════════════════════════════════
SECTION 2 — QUIZ RULES
═══════════════════════════════════════════════

• Generate EXACTLY the number of quiz questions specified in the user prompt. This is a hard requirement — count them before outputting.
• Cover ALL topics proportionally — do not over-represent any single topic.
• Test SPECIFIC facts from the material only — no generic knowledge questions.
• Each question must have EXACTLY 4 options (A, B, C, D).
• Distractors must be plausible alternatives from the same domain — not obviously wrong.
• The "correct" field is an integer 0–3 (0=A, 1=B, 2=C, 3=D).
• Explanation: state why the correct answer is right AND why the most tempting wrong option is wrong.
• Questions from tables/graphs/charts must reference specific data points, trends, or values shown.

═══════════════════════════════════════════════
SECTION 3 — SUMMARY RULES
═══════════════════════════════════════════════

• Title: maximum 8 words, captures the core subject.
• Sections: each section has a heading (3–6 words) and an array of bullet points.
• Each bullet point = one complete, specific fact with numbers/names/dates where available.
• Coverage: every major topic in the material must appear in at least one section.
• Depth is controlled by the user prompt — follow the section/bullet count specified there exactly.

═══════════════════════════════════════════════
SECTION 4 — JSON FORMAT (STRICT)
═══════════════════════════════════════════════

Return ONLY a valid JSON object. No markdown. No code fences. No explanation. Nothing before or after the JSON.

Schema:
{
  "flashcards": [{"topic": "string", "points": "string"}],
  "quiz": [{"question": "string", "options": ["string","string","string","string"], "correct": 0, "explanation": "string"}],
  "summary": {"title": "string", "sections": [{"heading": "string", "points": ["string"]}]}
}

Strict formatting rules:
1. Every string on ONE line — absolutely no newlines or tabs inside any string value.
2. Points field: pipe-separated " | " (space pipe space).
3. NO double-quote characters inside string values — rephrase to avoid them.
4. NO trailing commas anywhere.
5. All JSON keys double-quoted. No single quotes anywhere.
6. "correct" is always an integer 0, 1, 2, or 3 — never a string.
7. options array must always have exactly 4 string elements.`;

// ─── Grok 4.1 Fast via OpenRouter ──────────────────────────────────────────

async function callGrok(userMessageContent, count, maxQuiz, summaryDepth) {
  const openRouterKey = process.env.OPENROUTER_API_KEY;
  if (!openRouterKey) throw new Error('OpenRouter API key not configured');

  const depthInstructions = {
    concise:     '3–4 sections, 2–3 bullet points each',
    standard:    '4–6 sections, 3–5 bullet points each',
    detailed:    '5–7 sections, 4–6 bullet points each',
    'deep dive': '6–8 sections, 5–7 bullet points each',
  };
  const depthNote = depthInstructions[summaryDepth] || depthInstructions.standard;

  const countNote = count > 15
    ? `CRITICAL: You MUST return EXACTLY ${count} flashcard objects. Count them before responding. Not ${count-2}, not ${count+2} — exactly ${count}.`
    : `Return exactly ${count} flashcard objects.`;

  const userInstruction = `TASK PARAMETERS:
• Flashcards: ${countNote}
• Quiz: Generate EXACTLY ${maxQuiz} quiz questions — count before outputting.
• Summary depth: ${depthNote}

Now analyse the study material below and return the JSON object.`;

  // userMessageContent is either a string (text) or an array (multimodal with images)
  const userContent = typeof userMessageContent === 'string'
    ? `${userInstruction}\n\nStudy material:\n${userMessageContent}`
    : [
        { type: 'text', text: userInstruction + '\n\nStudy material:' },
        ...userMessageContent,
      ];

  const maxTokens = Math.min(8000, 2000 + count * 100 + maxQuiz * 100);

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openRouterKey}`,
      'HTTP-Referer': 'https://cogniswift.in',
      'X-Title': 'CogniSwift',
    },
    body: JSON.stringify({
      model: 'x-ai/grok-4-1-fast',
      max_tokens: maxTokens,
      temperature: 0.15,
      messages: [
        { role: 'system', content: GROK_SYSTEM_PROMPT },
        { role: 'user',   content: userContent },
      ],
    }),
  });

  const data = await response.json();
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));

  const raw = (data.choices?.[0]?.message?.content || '').trim();
  return raw;
}

// ─── Groq fallback chain (free tier / plain text) ──────────────────────────

async function callGroq(prompt) {
  const apiKey  = process.env.GROQ_API_KEY;
  const apiKey2 = process.env.GROQ_API_KEY_2;
  if (!apiKey) throw new Error('Groq API key not configured');

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

  let lastError = 'All Groq models exhausted';

  for (const { key, model } of attempts) {
    try {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({
          model,
          max_tokens: 5000,
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.15,
          response_format: { type: 'json_object' },
        }),
      });

      const data = await groqRes.json();
      if (data.error) {
        lastError = data.error.message || JSON.stringify(data.error);
        if (isRateLimitGroq(groqRes.status, data.error)) continue;
        if (groqRes.status === 401 || groqRes.status === 403)
          throw new Error('Invalid Groq API key');
        continue;
      }

      return (data.choices?.[0]?.message?.content || '').trim();

    } catch (err) {
      lastError = err.message || 'Unknown';
      continue;
    }
  }

  throw new Error(lastError);
}

// ─── Main handler ──────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const {
    text,           // extracted text (always present)
    count,          // number of flashcards requested
    images,         // array of base64 image strings (Elite/Pro PDF pages) — optional
    isFileUpload,   // boolean: true = came from PDF/image upload, false = plain text paste
    summaryDepth,   // 'concise'|'standard'|'detailed'|'deep dive' — Elite only, defaults standard
    access_token,   // user's Supabase auth token — needed to determine tier
  } = req.body;

  if (!text || !count) return res.status(400).json({ error: 'Missing text or count' });

  // ── Determine user tier ──────────────────────────────────────────────────
  let tier = 'free';
  if (access_token) {
    try {
      const { data: { user }, error } = await supabase.auth.getUser(access_token);
      if (!error && user) {
        const { data: dbUser } = await supabase
          .from('users')
          .select('tier, sub_expiry')
          .eq('id', user.id)
          .single();
        if (dbUser?.tier && dbUser.tier !== 'free') {
          // Safety check: confirm subscription hasn't expired
          const expiry = dbUser.sub_expiry ? new Date(dbUser.sub_expiry) : null;
          if (!expiry || expiry.getTime() > Date.now()) {
            tier = dbUser.tier; // 'pro' or 'elite'
          }
        }
      }
    } catch (_) {
      // If tier check fails, fall back to free — never error out the user
    }
  }

  // ── Input length caps by tier ────────────────────────────────────────────
  const charLimit = tier === 'elite' ? 30000 : tier === 'pro' ? 20000 : 6000;
  const inputText = text.substring(0, charLimit);
  const wordCount = inputText.split(/\s+/).filter(Boolean).length;

  // ── Quiz count scales with content size ─────────────────────────────────
  const maxQuiz = wordCount < 400 ? 5 : wordCount < 900 ? 10 : 20;

  // ── Language detection (same logic as before) ────────────────────────────
  const langInstruction = detectLanguage(inputText);

  // ── Decide routing ───────────────────────────────────────────────────────
  // Plain text paste → always Groq regardless of tier
  // File upload + paid tier → Grok 4.1
  // File upload + free tier → Groq (text only)
  const usePaidModel = isFileUpload && (tier === 'pro' || tier === 'elite');

  // ── Images: only used for Elite when provided ────────────────────────────
  // Pro gets Grok but text-only (no image bytes sent — AI still processes
  // tables/charts from the extracted text which PDF.js captures well)
  // Elite gets images when the PDF has non-selectable/scanned pages
  const hasImages = Array.isArray(images) && images.length > 0;
  const sendImages = tier === 'elite' && hasImages;

  // ── PAID PATH: Grok 4.1 Fast via OpenRouter ─────────────────────────────
  if (usePaidModel) {
    try {
      // Vision instruction varies by tier
      const visionRule = sendImages
        ? (tier === 'elite'
            ? `VISUAL PROCESSING RULE: This material contains images of document pages. You MUST analyse ALL visual content — text, tables, graphs, charts, handwritten notes, diagrams, flowcharts, equations, and any other visual element. Extract every piece of information visible.`
            : `VISUAL PROCESSING RULE: This material contains images of document pages. Process text, tables, graphs, and charts only. Do NOT attempt to interpret handwritten content or informal diagrams.`)
        : `VISUAL PROCESSING RULE: Process the provided text content. Pay special attention to any tabular data, numerical data, or structured information — treat it with the same rigour as visual tables and charts.`;

      const countNote = count > 15
        ? `CRITICAL: You MUST return EXACTLY ${count} flashcard objects. Count them before responding.`
        : `Return exactly ${count} flashcard objects.`;

      // Build user message content
      let userMessageContent;

      if (sendImages) {
        // Multimodal: text instruction + image pages
        const imageBlocks = images.map(b64 => ({
          type: 'image_url',
          image_url: {
            url: b64.startsWith('data:') ? b64 : `data:image/jpeg;base64,${b64}`,
          },
        }));
        userMessageContent = [
          {
            type: 'text',
            text: `${langInstruction}\n\n${visionRule}\n\nFlashcard count: ${countNote}\nQuiz count: EXACTLY ${maxQuiz} questions.\nSummary depth: ${(summaryDepth && tier === 'elite') ? summaryDepth : 'standard'}.`,
          },
          ...imageBlocks,
          // Also include extracted text as additional context
          { type: 'text', text: `Extracted text from document (use alongside images):\n${inputText}` },
        ];
      } else {
        // Text only (Pro, or Elite with fully selectable PDF)
        userMessageContent = `${langInstruction}\n\n${visionRule}\n\nFlashcard count: ${countNote}\nQuiz count: EXACTLY ${maxQuiz} questions.\nSummary depth: ${(summaryDepth && tier === 'elite') ? summaryDepth : 'standard'}.\n\nStudy material:\n${inputText}`;
      }

      const raw = await callGrok(userMessageContent, count, maxQuiz, (summaryDepth && tier === 'elite') ? summaryDepth : 'standard');
      const parsed = parseAndValidate(raw);

      parsed.flashcards = deduplicateTopics(parsed.flashcards);
      parsed.flashcards = padToCount(parsed.flashcards, count);
      parsed.quiz = parsed.quiz.slice(0, maxQuiz);
      // summary is included in parsed from Grok response

      return res.status(200).json(parsed);

    } catch (err) {
      // If Grok fails for any reason, fall through to Groq as safety net
      // (so paid users are never left with a broken experience)
      console.error('Grok error, falling back to Groq:', err.message);
    }
  }

  // ── FREE PATH (or fallback): Groq ────────────────────────────────────────

  const countNote = count > 15
    ? `CRITICAL: You MUST return EXACTLY ${count} flashcard objects. Count them before responding. Not ${count-2}, not ${count+2} — exactly ${count}.`
    : `Return exactly ${count} flashcard objects.`;

  const groqPrompt = `You are a subject-matter expert creating high-quality revision flashcards for serious Indian competitive exam students (UPSC, JEE, NEET, CA, etc.).

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

  try {
    const raw = await callGroq(groqPrompt);
    const parsed = parseAndValidate(raw);

    parsed.flashcards = deduplicateTopics(parsed.flashcards);
    parsed.flashcards = padToCount(parsed.flashcards, count);
    parsed.quiz = parsed.quiz.slice(0, maxQuiz);

    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(503).json({ error: `Generation failed: ${err.message}` });
  }
}
