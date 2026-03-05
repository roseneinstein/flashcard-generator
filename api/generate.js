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

  const prompt = `You are an expert study assistant for Indian competitive exams (UPSC, JEE, NEET, CA).

Given the study notes below, return ONLY a valid JSON object. No markdown, no code fences, no explanation. Just the raw JSON.

The JSON must have exactly this structure:
{"flashcards":[{"topic":"short title","points":"line1\nline2\nline3"}],"quiz":[{"question":"...","options":["A","B","C","D"],"correct":0,"explanation":"..."}]}

Rules:
- Exactly ${count} flashcards. topic = short title. points = bullet lines separated by \n using only plain ASCII hyphens like - point one
- Exactly 5 quiz questions. correct = 0-based index.
- Use ONLY plain ASCII characters. No special quotes, no em-dashes, no unicode bullets.
- Do not use newlines inside any JSON string value except the literal backslash-n sequence.

Notes:
${text.substring(0, 2500)}`;

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
        temperature: 0.3,
      }),
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    let raw = data.choices[0].message.content.trim();

    // Strip any markdown fences
    raw = raw.replace(/```json/g, '').replace(/```/g, '').trim();

    // Remove actual newlines and control chars inside string values
    // Replace literal newlines with \n sequence so JSON.parse works
    raw = raw.replace(/[\u0000-\u001F\u007F]/g, function(ch) {
      if (ch === '\n') return '\\n';
      if (ch === '\r') return '';
      if (ch === '\t') return ' ';
      return '';
    });

    const parsed = JSON.parse(raw);
    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Something went wrong' });
  }
}
