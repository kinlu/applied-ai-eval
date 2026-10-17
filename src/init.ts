/**
 * `aieval init`: a starting config, an adapter stub and one example case.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeText } from './util.js';

const CONFIG = `// Eval config. Docs: https://github.com/kinlu/applied-ai-eval
/** @type {import('applied-ai-eval').EvalConfig} */
export default {
  name: 'my-app',
  // Runs your production pipeline for one case; see eval/app-adapter.mjs.
  app: { module: './eval/app-adapter.mjs' },
  // Named configurations to compare (prompt version, model, temperature...). The first runs by default.
  variants: {
    baseline: {},
    // candidate: { model: 'another-model' },
  },
  // Inputs the output may be grounded in, and inputs it should answer rather than repeat.
  sources: ['context', 'request'],
  echoOf: ['request'],
  // Optional LLM judge (needs AIEVAL_JUDGE_MODEL and an API key):
  // judge: {
  //   dimensions: [
  //     { key: 'grounded', description: 'Every claim is supported by the context.' },
  //     { key: 'answers_request', description: 'The output does what the request asks.' },
  //   ],
  // },
};
`;

const ADAPTER = `// Connects the eval to your app. Call the same code path production uses:
// the same prompts, protocol, validators and post-processing.
export async function run({ caseId, inputs, variant, sample }, ctx) {
  // const answer = await myPipeline(inputs.request, inputs.context, { ...variant.options, signal: ctx.signal });
  //
  // Report every LLM call (each attempt, failed ones too) so the run records tokens, cost and latency:
  // ctx.recordLlmCall({ agent: 'draft', model, servedModel, status: 'ok', durationMs, promptTokens, completionTokens, reasoningTokens, costUsd });
  //
  // Return the final, user-visible output. Optional: stages (to count fallbacks), gates, artifacts, metrics.
  return { output: \`Replace eval/app-adapter.mjs with a call into your app (case \${caseId}).\` };
}
`;

const CASE = `{
  "title": "Example case: replace with a real scenario from your product",
  "tags": ["example"],
  "notes": "What this case is designed to exercise, and the mistake it makes available.",
  "inputs": {
    "request": { "file": "request.txt" },
    "context": { "file": "context.md" }
  },
  "carry": ["Refunds are available within 30 days of purchase."],
  "traps": [
    {
      "id": "no-invented-window",
      "description": "The answer must not promise a refund window the context does not state.",
      "mustNotMatch": ["\\\\b(?:60|90)[- ]day"]
    }
  ],
  "review": ["Does the answer say only what the context supports?"]
}
`;

const REQUEST = `Hi, I bought the annual plan 6 weeks ago. Your site said I could get a refund within 60 days, right?
`;

const CONTEXT = `# Refunds

Refunds are available within 30 days of purchase. Refunds go back to the original payment method within 5 business days.
`;

const HOLDOUT_README = `# Hold-out cases

Acceptance only. Tune prompts, rules and thresholds against eval/cases/ and run these once at the
end of a change (\`aieval run --holdout\`). Use other scenarios than the tuning cases cover.

If you read a hold-out output to diagnose a problem, record it (\`aieval holdout seen <case> --note "..."\`),
fix the problem against eval/cases/, and add fresh hold-out cases before the next acceptance run.
Never add real personal data here or in eval/cases/: write fictional, neutralised cases.
`;

export function initProject(dir: string): { created: string[]; skipped: string[] } {
  const files: Array<[string, string]> = [
    ['eval.config.mjs', CONFIG],
    ['eval/app-adapter.mjs', ADAPTER],
    ['eval/cases/example-refund/case.json', CASE],
    ['eval/cases/example-refund/request.txt', REQUEST],
    ['eval/cases/example-refund/context.md', CONTEXT],
    ['eval/holdout/README.md', HOLDOUT_README],
  ];
  const created: string[] = [];
  const skipped: string[] = [];
  for (const [path, content] of files) {
    const target = join(dir, path);
    if (existsSync(target)) {
      skipped.push(path);
      continue;
    }
    writeText(target, content);
    created.push(path);
  }
  const gitignore = join(dir, '.gitignore');
  const ignored = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
  if (!/^eval\/reports\/?$/m.test(ignored)) {
    appendFileSync(gitignore, `${ignored && !ignored.endsWith('\n') ? '\n' : ''}# Eval runs contain model outputs\neval/reports/\n`);
    created.push('.gitignore (eval/reports/)');
  }
  return { created, skipped };
}
