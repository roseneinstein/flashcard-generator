export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { text, count } = req.body;
  if (!text || !count) return res.status(400).json({ error: 'Missing text or count' });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

  const prompt = `You are a study assistant for Indian competitive exams.

Return ONLY a valid JSON object. No markdown. No code fences. No extra text.

Schema:
{"flashcards":[{"topic":"string","points":"string"}],"quiz":[{"question":"string","options":["string","string","string","string"],"correct":0,"explanation":"string"}]}

STRICT RULES — violations break the parser:
1. Exactly ${count} flashcard objects in the flashcards array.
2. Exactly 5 quiz objects in the quiz array.
3. No newlines or tabs inside any string value — one line only.
4. Separate points with pipe: "first point | second point | third point"
5. NO double-quote characters inside string values. Use a comma instead.
6. NO trailing commas after the last item in any array or object.
7. NO single quotes anywhere. All keys and values use double quotes.
8. correct is an integer 0-3.

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
      }),
    });

    const data = await groqRes.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    let raw = data.choices[0].message.content.trim();

    // 1. Strip markdown fences
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    // 2. Extract outermost { ... }
    const first = raw.indexOf('{');
    const last  = raw.lastIndexOf('}');
    if (first === -1 || last === -1) return res.status(500).json({ error: 'AI did not return JSON' });
    raw = raw.slice(first, last + 1);

    // 3. Replace all real whitespace control chars with a space
    raw = raw.replace(/[\r\n\t\x0B\x0C]+/g, ' ');

    // 4. Multi-pass repair
    raw = repair(raw);

    try {
      const parsed = JSON.parse(raw);
      return res.status(200).json(parsed);
    } catch (e) {
      return res.status(500).json({ error: 'AI returned malformed JSON: ' + e.message });
    }

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Something went wrong' });
  }
}

function repair(s) {
  // --- pass 1: trailing commas before ] or } ---
  // e.g.  ,"value",}  →  ,"value"}
  s = s.replace(/,\s*([}\]])/g, '$1');

  // --- pass 2: single-quoted keys/values → double-quoted ---
  // only fire when a single-quote appears right after { , [ or : (structural positions)
  s = s.replace(/(['"])(.*?)\1\s*:/g, (match, q, key) => `"${key}":`);

  // --- pass 3: unescaped double-quotes INSIDE string values ---
  // Walk char by char; when inside a string, escape any " not preceded by \
  let out = '';
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\\') {
        out += c + s[++i];          // skip escaped char
        continue;
      }
      if (c === '"') {
        // Is this a legitimate closing quote?
        // Next non-space char must be structural: : , ] } or end
        let j = i + 1;
        while (j < s.length && s[j] === ' ') j++;
        const nx = s[j];
        if (!nx || nx === ':' || nx === ',' || nx === ']' || nx === '}') {
          inStr = false;
          out += '"';
        } else {
          out += '\\"';             // rogue quote — escape it
        }
        continue;
      }
      out += c;
    } else {
      if (c === '"') { inStr = true; out += '"'; continue; }
      out += c;
    }
  }
  return out;
}
