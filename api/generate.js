export default async function handler(req, res) {

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { text, count } = req.body;

  if (!text || !count) {
    return res.status(400).json({ error: 'Missing text or count' });
  }

  // API key lives HERE on the server — never visible to browser
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: 'API key not configured on server' });
  }

  const prompt = `You are an expert study assistant for Indian competitive exams (UPSC, JEE, NEET, CA).

Given these study notes, return ONLY valid JSON (no markdown, no explanation):

{
  "flashcards": [{"question":"...","answer":"..."}],
  "quiz": [{"question":"...","options":["...","...","...","..."],"correct":0,"explanation":"..."}]
}

Rules:
- Exactly ${count} flashcards. Clear questions, concise answers (2-3 sentences).
- Exactly 5 MCQ quiz questions. Must be answerable from the flashcards alone.
- "correct" = 0-indexed position of right answer.

Notes:
${text}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 3000,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();

    if (data.error) {
      return res.status(500).json({ error: data.error.message });
    }

    const raw = data.content[0].text.trim().replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(raw);

    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Something went wrong' });
  }
}
