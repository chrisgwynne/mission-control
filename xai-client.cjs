// xAI helper client (OpenAI-compatible)
// Uses env: XAI_API_KEY

const DEFAULT_BASE_URL = process.env.XAI_BASE_URL || 'https://api.x.ai/v1';

async function xaiChat({
  messages,
  model = process.env.XAI_MODEL || 'grok-4-latest',
  temperature = 0.2,
  stream = false,
  baseUrl = DEFAULT_BASE_URL,
  apiKey = process.env.XAI_API_KEY,
}) {
  if (!apiKey) throw new Error('XAI_API_KEY not set');
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ messages, model, temperature, stream }),
  });

  const text = await res.text();
  if (!res.ok) throw new Error(`xAI HTTP ${res.status}: ${text.slice(0, 400)}`);
  const j = text ? JSON.parse(text) : {};
  const content = j?.choices?.[0]?.message?.content ?? '';
  return { content: String(content || '').trim(), raw: j };
}

module.exports = { xaiChat };
