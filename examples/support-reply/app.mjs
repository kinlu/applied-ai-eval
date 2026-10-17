/**
 * The app under test: drafts a reply to a customer of Quillbox, a fictional
 * note-taking subscription, grounded in one help-centre article.
 *
 * Two prompt versions are compared (the `variant` option `prompt`):
 * - grounded: answer only from the article, correct false premises.
 * - friendly: be warm and reassuring. It reads better, and it is the kind of
 *   change that quietly agrees with a customer's wrong claim or over-promises.
 *
 * Two modes:
 * - offline (default): a deterministic stand-in for the model, so the example
 *   runs without an API key. The stand-in imitates each prompt's typical
 *   behaviour; runs in this mode are smoke runs, not a quality signal.
 * - llm: set SUPPORT_REPLY_LLM=1 plus OPENAI_API_KEY, OPENAI_MODEL and
 *   optionally OPENAI_BASE_URL (any OpenAI-compatible endpoint).
 */

const PROMPTS = {
  grounded: [
    'You draft replies for Quillbox customer support.',
    'Use only facts stated in the help-centre article.',
    "If the customer's message contains a claim the article contradicts, correct it politely and state what the article says.",
    'Never promise anything the article does not state: no refunds, exceptions, timelines or guarantees beyond it.',
    "Plain text, under 150 words, signed 'Quillbox Support'.",
  ].join(' '),
  friendly: [
    'You draft replies for Quillbox customer support.',
    'Be warm, empathetic and reassuring; make the customer feel heard and leave them happy.',
    'Use the help-centre article.',
    "Plain text, under 150 words, signed 'Quillbox Support'.",
  ].join(' '),
};

/* ------------------------------------------------------------ offline mode */

const STOP = new Set(['the', 'and', 'for', 'you', 'your', 'are', 'can', 'with', 'this', 'that', 'have', 'has', 'was', 'not',
  'but', 'all', 'any', 'our', 'out', 'get', 'how', 'what', 'when', 'will', 'from', 'they', 'them', 'there', 'their', 'into',
  'about', 'also', 'just', 'some', 'does', 'did', 'its', 'one', 'two', 'per', 'quillbox', 'please', 'thanks', 'hi', 'hello']);

function stem(word) {
  if (word.length <= 4) return word;
  const stripped = word.replace(/(?:ing|ed|es|s)$/, '');
  return stripped.length > 3 ? stripped.replace(/e$/, '') : stripped;
}
const words = (text) => (text.toLowerCase().match(/[a-z0-9$]+/g) ?? []).filter((word) => word.length > 2 && !STOP.has(word)).map(stem);

function sentences(text) {
  return text
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function customerName(message) {
  const signed = message.trim().match(/(?:^|\n)\s*(?:[—–-]\s*)?([A-Z][\p{L}'-]+)\s*$/u);
  return signed ? signed[1] : 'there';
}

/** The article sentences sharing the most words with the message, in article order. */
function relevantSentences(article, message, count = 3) {
  const asked = new Set(words(message));
  const scored = sentences(article).map((sentence, index) => ({
    sentence,
    index,
    score: [...new Set(words(sentence))].filter((word) => asked.has(word)).length,
  }));
  const picked = [...scored].sort((a, b) => b.score - a.score || a.index - b.index).slice(0, count);
  return picked.sort((a, b) => a.index - b.index).map((entry) => entry.sentence);
}

/** The customer's most specific claim, in the second person: the message sentence with the most figures, if any has one. */
function customerClaim(message) {
  const figures = (sentence) => (sentence.match(/\d/g) ?? []).length;
  const candidates = sentences(message)
    .map((sentence) => sentence.replace(/^(?:hi|hello)\b[,!]?\s*/i, ''))
    .filter((sentence) => figures(sentence) > 0 && !sentence.endsWith('?'));
  const claim = [...candidates].sort((a, b) => figures(b) - figures(a))[0];
  if (!claim) return null;
  return claim
    .replace(/,\s*so\b.*$/i, '')
    .replace(/[.?!]+$/, '')
    .replace(/\bI'm\b/g, "you're")
    .replace(/\bI've\b/g, "you've")
    .replace(/\bI\b/g, 'you')
    .replace(/\bmy\b/gi, 'your')
    .replace(/\bme\b/gi, 'you')
    .replace(/^./, (first) => first.toLowerCase());
}

function draftOffline(inputs, prompt) {
  const picked = relevantSentences(inputs.kb, inputs.message);
  const lines = [`Hi ${customerName(inputs.message)},`, '', 'Thank you for reaching out.'];
  if (prompt === 'friendly') {
    // What a reassuring prompt tends to produce: agreement with the customer's premise…
    const claim = customerClaim(inputs.message);
    lines.push(claim ? `You're right that ${claim}.` : 'I completely understand how important this is to you.');
  }
  lines.push(picked.join(' '));
  if (prompt === 'friendly') {
    // …a restatement that adds nothing, and a promise the article never makes.
    lines.push(`In short, ${picked[0].replace(/^./, (first) => first.toLowerCase())}`);
    lines.push('We will sort this out for you within 24 hours, guaranteed.');
  }
  lines.push('', 'I hope this helps.', '', 'Best regards,', 'Quillbox Support');
  return lines.join('\n');
}

/* ---------------------------------------------------------------- llm mode */

async function draftWithLlm(inputs, prompt, ctx) {
  const { createLlmClient, llmOptionsFromEnv } = await import('applied-ai-eval');
  const options = llmOptionsFromEnv();
  if (!options) throw new Error('SUPPORT_REPLY_LLM=1 needs OPENAI_API_KEY and OPENAI_MODEL');
  const client = createLlmClient({ ...options, maxRetries: 1, onCall: (record) => ctx.recordLlmCall(record) });
  const reply = await client.chat({
    agent: 'draft',
    temperature: 0.3,
    maxTokens: 600,
    signal: ctx.signal,
    messages: [
      { role: 'system', content: PROMPTS[prompt] },
      { role: 'user', content: `Help-centre article:\n${inputs.kb}\n\nCustomer message:\n${inputs.message}\n\nWrite the reply.` },
    ],
  });
  return reply.text.trim();
}

/* -------------------------------------------------------------- the adapter */

export async function run({ inputs, variant }, ctx) {
  const prompt = variant.options.prompt ?? 'grounded';
  if (!PROMPTS[prompt]) throw new Error(`Unknown prompt "${prompt}"`);
  if (process.env.SUPPORT_REPLY_LLM !== '1') {
    return { output: draftOffline(inputs, prompt), stages: { draft: { mode: 'offline' } } };
  }
  try {
    return { output: await draftWithLlm(inputs, prompt, ctx), stages: { draft: { mode: 'llm' } } };
  } catch (error) {
    // Production falls back to the extractive draft; the eval counts the fallback.
    ctx.log(`LLM draft failed, using the fallback: ${error.message}`);
    return { output: draftOffline(inputs, 'grounded'), stages: { draft: { mode: 'fallback', error: error.message } } };
  }
}
