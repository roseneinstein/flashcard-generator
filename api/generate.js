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

Given the study notes below, return ONLY valid JSON with NO markdown fences.

FLASHCARDS: Each card has a "topic" (short title) and "points" (study content).
For "points", use this format — bullet lines starting with →, flow chains using A → B → C, and **bold** for key terms. Include mini-tables using | col1 | col2 | format where useful. Be precise and scannable — these are MEMORY AIDS not paragraphs.

QUIZ: 5 MCQ questions to test what was learned from the flashcards.

Return exactly this structure:
{
  "flashcards": [{"topic":"...","points":"→ point one\n→ point two\n**Key term**: explanation\nA → B → C"}],
  "quiz": [{"question":"...","options":["...","...","...","..."],"correct":0,"explanation":"..."}]
}

Rules:
- Exactly ${count} flashcards
- Exactly 5 quiz questions
- "correct" = 0-based index of right answer
- flashcard points must be scannable, not paragraph prose

Notes:
${text}`;

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
        temperature: 0.4,
      }),
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error.message });

    const raw = data.choices[0].message.content
      .trim()
      .replace(/```json|```/g, '')
      .trim();

    const parsed = JSON.parse(raw);
    return res.status(200).json(parsed);

  } catch (err) {
    return res.status(500).json({ error: err.message || 'Something went wrong' });
  }
}
