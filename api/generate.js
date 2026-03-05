export default async function handler(req, res) {

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { text, count } = req.body;

  if (!text || !count) {
    return res.status(400).json({ error: 'Missing text or count' });
  }

  // Gemini API key — stored safely in Vercel environment variables
  const apiKey = process.env.GEMINI_API_KEY;

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
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 3000, temperature: 0.7 },
        }),
      }
    );

    const data = await response.json();

    if (data.error) {
      return res.status(500).json({ error: data.error.message });
    }

    const raw = data.candidates[0].content.parts[0].text
      .trim()
      .replace(/```json|```/g, '')
      .trim();

    const parsed = JSON.parse(raw);
    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Something went wrong' });
  }
}
