export default async function handler(req, res) {

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { text, count } = req.body;
  if (!text || !count) {
    return res.status(400).json({ error: 'Missing text or count' });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured' });
  }

  const prompt = `You are a study assistant for Indian competitive exams.

Return ONLY a JSON object. No markdown. No code fences. No extra text before or after.

Schema:
{"flashcards":[{"topic":"string","points":"string"}],"quiz":[{"question":"string","options":["string","string","string","string"],"correct":0,"explanation":"string"}]}

CRITICAL RULES:
1. Exactly ${count} flashcard objects.
2. Exactly 5 quiz objects.
3. All string values must be on ONE line. Never use a real newline or tab inside any string value.
4. Separate bullet points inside "points" using the pipe character | like this: "point one | point two | point three"
5. Do NOT use double-quote characters inside any string value. Use a comma or semicolon instead.
6. Do NOT use backslashes inside any string value.
7. correct is a number 0 to 3.
8. Keep topics short (4-7 words). Keep points concise.

Study notes:
${text.substring(0, 2000)}`;

  try {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 3500,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
      }),
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    let raw = data.choices[0].message.content.trim();

    // Strip markdown fences
    raw = raw.replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '').trim();

    // Find the JSON object — start at first { end at last }
    const firstBrace = raw.indexOf('{');
    const lastBrace = raw.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1) {
      return res.status(500).json({ error: 'AI did not return valid JSON' });
    }
    raw = raw.slice(firstBrace, lastBrace + 1);

    // Remove all control characters (newlines, tabs, carriage returns etc.)
    raw = raw.replace(/[\x00-\x1F\x7F]+/g, ' ');

    // Repair unescaped double-quotes inside JSON string values.
    // Strategy: walk char by char tracking whether we're inside a string,
    // and fix any unescaped " that appears mid-string.
    raw = repairJSON(raw);

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (parseErr) {
      // Last resort: return the error with a snippet for debugging
      return res.status(500).json({
        error: 'AI returned malformed JSON: ' + parseErr.message,
      });
    }

    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Something went wrong' });
  }
}

/**
 * Walk the raw string and escape any bare double-quote characters that appear
 * inside a JSON string value (i.e. not already escaped and not a structural quote).
 */
function repairJSON(str) {
  let out = '';
  let inString = false;
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (inString) {
      if (ch === '\\') {
        // Already-escaped sequence — copy both chars and skip
        out += ch + (str[i + 1] || '');
        i += 2;
        continue;
      }
      if (ch === '"') {
        // This quote either closes the string or is a rogue unescaped quote.
        // Peek ahead: after closing quote the next non-space char should be
        // one of : , ] } — if it's not, this is a rogue quote inside the value.
        let j = i + 1;
        while (j < str.length && str[j] === ' ') j++;
        const next = str[j];
        if (next === ':' || next === ',' || next === ']' || next === '}' || j >= str.length) {
          // Looks like a legitimate closing quote
          inString = false;
          out += '"';
        } else {
          // Rogue quote — escape it
          out += '\\"';
        }
        i++;
        continue;
      }
      out += ch;
      i++;
    } else {
      if (ch === '"') {
        inString = true;
        out += '"';
        i++;
        continue;
      }
      out += ch;
      i++;
    }
  }
  return out;
}
