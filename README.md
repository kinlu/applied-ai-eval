# applied-ai-eval

Evaluate an applied AI app the way you ship it: run your real pipeline over golden cases, score the final output with deterministic grounding checks, and compare a candidate (a new prompt, model or setting) against the baseline before you adopt it.

[中文说明](README.zh-CN.md)

```text
golden cases ──► your production pipeline ──► final output ──► checks + gates + traps ──► report.json
 (fictional,       (same prompts, protocol,     (what a user     (numbers traceable?        │
  with traps)       validators, fallbacks)       actually sees)   echo? duplicates? schema?) │
                                                                                            ▼
                         baseline run ──────────────────────────► aieval compare ◄──── candidate run
                                                                  verdict per metric, beyond noise
```

## Why

LLM apps regress quietly. A prompt that reads warmer starts agreeing with a customer's wrong claim. A cheaper model keeps "6 days" but drops "from 10 days". A reasoning setting improves the judge score a little and multiplies latency until requests time out and production falls back to its deterministic path without anyone noticing. Unit tests check code paths, and public benchmarks measure models. Neither measures what your app gives a user.

This toolkit measures exactly that, run over run, so every change ships with a before/after table.

## The method

1. **Evaluate the production path end to end.** Run the same prompts, protocol, validators and post-processing a user's request goes through, and measure the final, user-visible output. Vary one thing at a time.
2. **Write golden cases that can be failed.** Fictional, neutralised inputs covering the variety your users bring, each with planted traps: a number restated on a different basis, a preference stated as a decision, a claim the reference document contradicts.
3. **Tune on cases, accept on a hold-out set.** Hold-out cases cover other scenarios and are run once, at the end. Reading a hold-out output burns it: record that, and add fresh cases.
4. **Deterministic checks first.** Numbers traceable to an input, no lines built from words no input uses, no parroting of the request, no near-duplicates, no dropped baselines or qualifiers. They are cheap, exact and repeatable.
5. **Gates before quality.** An output that breaks the protocol (invalid schema, missing tool call, timeout, wrong language) is unusable however good it reads.
6. **Samples, not single runs.** Two or more samples per cell separate structural differences from sampling noise.
7. **An LLM judge second, with measured noise.** Fixed judge model, integer rubric, judged back to back from saved outputs, with the judge's own spread measured on identical outputs.
8. **Compare, then decide.** Adopt a change only if no quality metric regresses beyond its noise. Cost and latency changes are trade-offs a person accepts or rejects, with the numbers.
9. **Count what it really costs.** Billed cost from the provider, hidden reasoning tokens, failed calls, fallbacks, and the model the provider actually served.
10. **Keep every artifact.** Re-score when a metric definition changes and re-judge when the judge changes, without regenerating.
11. **A run without model calls is a smoke test**, not a quality signal. Say so in the report.
12. **Write down what you did not verify.**

The full reasoning, with the lessons behind each rule, is in [docs/methodology.md](docs/methodology.md).

## Quick start

Requires Node.js 20 or later.

```bash
git clone https://github.com/kinlu/applied-ai-eval && cd applied-ai-eval
npm install                      # also builds dist/

# Run the example app (a fictional support-reply drafter) with two prompt versions.
node dist/cli.js run --config examples/support-reply/eval.config.mjs --variant baseline,friendly

# Compare them: the run directory is printed by the previous command.
node dist/cli.js compare examples/support-reply/eval/reports/<run>#baseline \
                         examples/support-reply/eval/reports/<run>#friendly
```

The example runs offline with a deterministic stand-in for the model, so the run is labelled a smoke run. Its "friendly" prompt agrees with the customer's wrong claim, pads the reply and makes a promise the help article never makes, and the comparison catches it:

```text
**Verdict: 8 quality regression(s)** — Runs with a failed gate (0 → 1); Numbers no source states (0 → 6);
Numbers traceable to a source (100.0% → 63.1%); Lines using words no source uses (0 → 18);
Near-duplicate line pairs (0 → 6); Lines echoing message (0 → 4); Traps failed (0 → 1);
Gate passed: trap:accepts-false-claim (100.0% → 0.0%).
```

With an OpenAI-compatible endpoint the same example runs on a real model; see [examples/support-reply](examples/support-reply/README.md).

## Use it in your project

```bash
npm install --save-dev github:kinlu/applied-ai-eval
npx aieval init        # eval.config.mjs, eval/app-adapter.mjs, an example case, eval/reports/ in .gitignore
```

**1. Connect your app.** The adapter calls your production code for one case and returns the final output:

```js
// eval/app-adapter.mjs
import { draftReply } from '../src/reply.js';

export async function run({ caseId, inputs, variant, sample }, ctx) {
  const reply = await draftReply(inputs.message, inputs.kb, {
    ...variant.options,                          // e.g. { prompt: 'v2' } or { model: '...' }
    signal: ctx.signal,                          // aborted on timeout
    onLlmCall: (call) => ctx.recordLlmCall(call) // tokens, cost, latency, served model
  });
  return {
    output: reply.text,                          // what the user sees
    stages: { draft: { mode: reply.usedFallback ? 'fallback' : 'llm' } },
    gates: { schema_valid: reply.schemaValid },  // protocol checks your app already does
  };
}
```

Apps in other languages use a command (`{ command: ['swift', 'run', 'EvalAdapter'] }`, JSON on stdin and stdout) or an HTTP endpoint (`{ url: 'http://localhost:4000/eval' }`). See [docs/adapters.md](docs/adapters.md).

**2. Configure the eval.**

```js
// eval.config.mjs
export default {
  name: 'support-reply',
  app: { module: './eval/app-adapter.mjs' },
  variants: { baseline: { prompt: 'v1' }, candidate: { prompt: 'v2' } },
  sources: ['kb', 'message'],   // inputs the output may be grounded in
  echoOf: ['message'],          // inputs it should answer rather than repeat
  checks: ['numeric-traceability', 'unsupported-lines', 'near-duplicates', 'input-echo',
           'misspellings', { check: 'json-shape', gate: true }, { check: 'length', max: 1200 }],
  judge: { dimensions: [{ key: 'grounded', description: 'Every claim is stated in the article.' }] },
};
```

**3. Write cases.** One directory per case under `eval/cases/` (tuning) or `eval/holdout/` (acceptance only):

```text
eval/cases/refund-after-window/
├── case.json      title, tags, notes, inputs, traps, facts to carry, review questions
├── message.txt    the customer's message
└── kb.md          the help-centre article
```

```json
{
  "title": "Annual refund requested after the window, citing a wrong 60-day policy",
  "inputs": { "message": { "file": "message.txt" }, "kb": { "file": "kb.md" } },
  "carry": ["Annual Pro plans can be refunded in full within 30 days of purchase."],
  "traps": [
    { "id": "states-actual-window", "description": "States the actual 30-day window.", "mustInclude": ["30 days"] },
    { "id": "accepts-false-claim", "description": "Must not agree with the 60-day claim.",
      "mustNotMatch": ["refund(?:ed|s)? within 60 days", "\\byou(?:'re| are) right\\b"], "gate": true }
  ],
  "review": ["Does the reply correct the claim politely and offer the next best option?"]
}
```

See [docs/writing-cases.md](docs/writing-cases.md) for every field and for trap patterns that work.

**4. Run, change, run, compare.**

```bash
npx aieval run --samples 2 --label before
# change the prompt, model or setting
npx aieval run --samples 2 --label after
npx aieval compare eval/reports/<before> eval/reports/<after> --out compare.md --fail-on-regression
npx aieval run --holdout --variant candidate      # once, for acceptance
```

## What a run writes

```text
eval/reports/<timestamp>[-holdout][-label]/
├── report.json        everything compare, judge and rescore read
├── report.md          gates, summary per variant, cost and latency, per case, traps, flagged lines, usage by agent
├── inputs.md          the exact inputs every variant received
├── review.md          the human review checklist: each case's traps and questions, with links to the outputs
└── artifacts/<case>/<variant>-s<sample>.{json,md}   every output, its checks and its LLM calls
```

Reports contain model outputs: keep `eval/reports/` out of git (`aieval init` adds it to `.gitignore`).

## Built-in checks

| Check | Flags | Key |
|---|---|---|
| `numeric-traceability` | numbers the output states that no input states | `numbers.untraceable`, `numbers.traceable` |
| `unsupported-lines` | lines using a content word no input uses (English) | `lines.unsupported` |
| `near-duplicates` | line pairs that restate each other, within a group | `lines.nearDuplicates` |
| `input-echo` | lines that parrot the request instead of answering from the sources | `lines.echo` |
| `misspellings` | near-misses of an input word ("Kuberentes"), words split by a stray space | `text.misspellings` |
| `baseline-drops` | an improvement kept without its starting value ("to 6 days" for "from 10 to 6") | `numbers.baselineDrops` |
| `qualifier-drops` | a fact stripped of its time window or approximation | `numbers.qualifierDrops` |
| `reasoning-leak` | the model's own reasoning in user-visible text | `text.reasoningLeaks` |
| `json-shape` | prose returned as JSON (optionally a gate) | `text.jsonShape` |
| `script-ratio` | output in the wrong script or language, English runs in CJK output | `text.scriptRatio`, `text.foreignRuns` |
| `length` | output length, with optional bounds as a gate | `text.length` |
| `schema` | structured output that violates a JSON Schema (gate) | `schema.errors` |

Case expectations always run: `traps` (literal or regex assertions, optionally gates), `keywords` and `carry` (facts the output must keep). Every run also records errors, timeouts, gates, fallbacks, LLM calls, tokens, billed and list-price cost, latency percentiles and the served model. Definitions, thresholds and their calibration: [docs/checks.md](docs/checks.md).

## CLI

```text
aieval run      [--config <file>] [--case a,b] [--tag t] [--holdout] [--variant a,b|all]
                [--samples N] [--label name] [--judge] [--concurrency N] [--timeout ms] [--reports <dir>]
aieval compare  <baseline-run>[#variant] <candidate-run>[#variant]
                [--out compare.md] [--fail-on-regression] [--judge-noise 0.16] [--tolerance key=value]...
aieval judge    <run> [--passes N] [--out <dir>]     # post-hoc LLM judge into <run>-judged/
aieval rescore  <run> [--out <dir>]                  # recompute checks from saved outputs
aieval holdout  status | seen <case> --note "why"
aieval init     [dir]
```

`--fail-on-regression` exits 1 when a quality metric regressed beyond its noise, so CI can block a change. The judge reads `AIEVAL_JUDGE_MODEL` and `AIEVAL_JUDGE_API_KEY` (or `OPENAI_API_KEY`), plus `AIEVAL_JUDGE_BASE_URL` for any OpenAI-compatible endpoint.

## Library

Everything the CLI does is exported, and every check is a plain function you can reuse in your own guards:

```js
import { numericTraceability, inputEcho, runEval, compareRuns, loadSelected } from 'applied-ai-eval';

numericTraceability('Refunds within 30 days, processed in 24 hours.', [article]).untraceable; // ['24']
```

## Docs

- [Methodology](docs/methodology.md): the rules, why they exist, and the lessons behind them
- [Writing cases](docs/writing-cases.md): the case format, traps that work, hold-out rules, privacy
- [Checks](docs/checks.md): every check, its threshold and calibration, its known limits
- [Adapters](docs/adapters.md): connecting apps in TypeScript, Python, Swift or over HTTP
- [Judge](docs/judge.md): rubric design, noise, back-to-back judging
- [Adopting it](docs/adopting.md): a policy for your repo's AGENTS.md / CLAUDE.md, PR checklist, CI

## Background

The method is extracted from the eval harnesses of two production apps: a resume-tailoring web app (TypeScript), whose eval runs every golden case through the full import, tailoring and render chain with a hold-out set, grounding metrics on the rendered output and a mandatory before/after comparison for every prompt or model change; and an on-device meeting assistant (Swift), whose model comparison drives the app's real multi-agent session over a hand-written meeting with planted traps, with protocol gates, repeated samples, billed cost including hidden reasoning tokens, and a human review pack.

## License

[MIT](LICENSE)
