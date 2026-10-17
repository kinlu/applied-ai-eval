/**
 * Eval config for the example support-reply app.
 *
 *   npx aieval run --config examples/support-reply/eval.config.mjs --variant baseline,friendly
 *   npx aieval compare <run>#baseline <run>#friendly
 */
/** @type {import('applied-ai-eval').EvalConfig} */
export default {
  name: 'support-reply (example)',
  app: { module: './app.mjs' },

  // Two prompt versions of the same app. The first one runs when --variant is not given.
  variants: {
    baseline: { prompt: 'grounded' },
    friendly: { prompt: 'friendly' },
  },

  // The reply may state what the article or the customer said; it should answer the
  // customer's message, not repeat it back.
  sources: ['kb', 'message'],
  echoOf: ['message'],

  checks: [
    'numeric-traceability',
    { check: 'unsupported-lines', allow: ['Quillbox'] },
    'near-duplicates',
    'input-echo',
    'misspellings',
    'baseline-drops',
    'qualifier-drops',
    'reasoning-leak',
    // Replies are plain prose: a JSON-shaped reply fails a gate.
    { check: 'json-shape', gate: true },
    { check: 'length', max: 1200 },
  ],

  // Used by `--judge` and `aieval judge` (needs AIEVAL_JUDGE_MODEL and an API key).
  judge: {
    dimensions: [
      { key: 'grounded', description: 'Every factual claim (policy, number, timeline, capability) is stated in the help-centre article; nothing is promised beyond it.' },
      { key: 'corrects_premise', description: "Where the customer assumes something the article contradicts, the reply corrects it clearly and politely. Score 5 when there is nothing to correct and the reply introduces no false premise." },
      { key: 'resolves', description: 'The reply answers every question the customer asked and gives the next step.' },
      { key: 'tone', description: 'Warm, concise and professional: no filler, no blame, no exaggerated empathy.' },
    ],
    render: ({ case: loaded, text }) => [
      'Help-centre article:', String(loaded.inputs.kb), '',
      'Customer message:', String(loaded.inputs.message), '',
      'Reply to score:', text,
    ].join('\n'),
  },

  // Cost and latency changes within 10% (the default) read as noise; tokens get 5%.
  tolerances: { 'llm.promptTokens': '5%', 'llm.completionTokens': '5%' },
};
