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
3. All string values must be on ONE line. Never put a real newline inside a string value.
4. Separate bullet points inside "points" using the pipe character | like this: "point one | point two | point three"
5. Use only basic ASCII. No special dashes, no curly quotes, no unicode.
6. correct is a number 0 to 3.

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

    // Remove all real control characters (newlines, tabs, etc.)
    raw = raw.replace(/[\x00-\x1F\x7F]+/g, ' ');

    const parsed = JSON.parse(raw);
    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Something went wrong' });
  }
}
