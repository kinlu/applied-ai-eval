# The LLM judge

Deterministic checks catch what can be checked exactly. A judge covers what needs judgment: emphasis, tone, whether a reply resolves the question. Its scores are measurements with noise, so the procedure matters more than the prompt.

## Configure a rubric

```js
judge: {
  dimensions: [
    { key: 'grounded', description: 'Every factual claim is stated in the help-centre article; nothing is promised beyond it.' },
    { key: 'resolves', description: 'The reply answers every question asked and gives the next step.' },
    { key: 'tone', description: 'Warm, concise and professional: no filler, no blame, no exaggerated empathy.' },
  ],
  instructions: 'You are a strict, consistent evaluator of customer-support replies.',   // optional
  render: ({ case: c, result, text }) => `Article:\n${c.inputs.kb}\n\nMessage:\n${c.inputs.message}\n\nReply:\n${text}`,
  model: 'vendor/judge-model',   // or AIEVAL_JUDGE_MODEL
  scale: { min: 1, max: 5 },     // default
}
```

- **One concrete property per dimension**, described so two people would score it alike. "Quality" is not a dimension.
- **Integer scale, temperature 0, JSON reply.** The harness builds the system prompt from the dimensions and parses `{ "<key>": n, ..., "comments": "..." }`; out-of-range scores count as missing.
- **Render only what the judge needs**: the inputs that define correctness and the output. By default it sees every input and the output text.

Credentials: `AIEVAL_JUDGE_MODEL` (or `judge.model`), `AIEVAL_JUDGE_API_KEY` (or `OPENAI_API_KEY`; another variable via `judge.apiKeyEnv`), and `AIEVAL_JUDGE_BASE_URL` (or `judge.baseUrl`, else `OPENAI_BASE_URL`) for any OpenAI-compatible endpoint.

## Procedure

1. **Fix the judge model** across every run you compare. Never let each candidate model judge its own output.
2. **Judge from saved outputs, back to back.** `aieval judge <baseline-run>` and `aieval judge <candidate-run>` in one sitting write `<run>-judged/`, leaving the runs untouched. Scores taken hours apart drift with the provider; the comparison warns when judgments are more than two hours apart.
3. **Measure the judge's noise.** `aieval judge <run> --passes 2` judges every output twice, averages the passes, and records each dimension's spread between passes. In the app this procedure comes from, the judge moved about ±0.16 per dimension on identical outputs.
4. **Compare with the noise.** `aieval compare` treats a judge delta within the measured noise (or `--judge-noise`) as no change.
5. **Read the comments** for the cases whose scores moved most; a score without a reason is hard to act on.

`aieval run --judge` scores inline, which is convenient for a single run but still needs the back-to-back pass for a comparison.

## What a judge is not for

- Facts a check can verify (numbers, required phrases, schema): a judge is slower, costs money and is noisier.
- Deciding alone. A judge delta inside its noise is no evidence; a large one is a reason to read the outputs, which `review.md` lays out side by side.
