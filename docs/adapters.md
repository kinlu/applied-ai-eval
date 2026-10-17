# Adapters

An adapter runs your app for one case and returns what a user would get. Whatever its form, it should call the production path: the same prompts, protocol, validators, guards, fallbacks and post-processing.

## The contract

Input, one per case × variant × sample:

```ts
{
  caseId: string;
  inputs: Record<string, unknown>;          // the case's inputs, files already read
  variant: { name: string; options: Record<string, unknown> };   // from the config's `variants`
  sample: number;                           // 1-based
}
```

Result (only `output` is required; a bare string or any value without an `output` key is taken as the output):

```ts
{
  output: unknown;                          // the final, user-visible output
  text?: string;                            // what the checks read, if not the output itself
  lines?: string[] | Record<string, string[]>;   // sentences/bullets, optionally grouped
  stages?: Record<string, { mode: string; attempts?: number; durationMs?: number; error?: string }>;
  gates?: Record<string, boolean | { pass: boolean; detail?: string }>;
  artifacts?: Record<string, unknown>;      // intermediate outputs, kept with the run
  files?: Record<string, string | Uint8Array>;   // e.g. a rendered PDF
  llmCalls?: LlmCallRecord[];               // if not reported through ctx.recordLlmCall
  metrics?: Record<string, number | { value: number | null; unit?; better?; label? }>;
}
```

- `stages` is how fallbacks become visible: report `mode: 'fallback'` (or `deterministic`) when a stage did not use the model.
- `gates` are protocol checks your app already performs: strict schema accepted, the required tool call made, the materials consulted before answering.
- Keep `artifacts` small but sufficient to judge or re-score the output later (for example, the parsed source record the output is measured against).

The run fails the `completed` gate when the adapter throws, times out (`timeoutMs`, default 10 minutes) or returns no text.

## Recording LLM calls

Report every attempt, failed ones included:

```ts
ctx.recordLlmCall({
  agent: 'draft',               // the stage or call site
  model: 'vendor/model',        // requested
  servedModel: 'vendor/model-2026-07-31',  // what the provider echoed, if it does
  status: 'ok',                 // or 'error'
  durationMs: 1840,
  promptTokens: 1210,
  completionTokens: 230,
  reasoningTokens: 96,          // hidden reasoning, billed but invisible
  costUsd: 0.00041,             // billed cost, when the provider reports it
});
```

Or use the bundled OpenAI-compatible client, which records each attempt for you:

```js
import { createLlmClient, llmOptionsFromEnv } from 'applied-ai-eval';

const client = createLlmClient({ ...llmOptionsFromEnv(), onCall: (call) => ctx.recordLlmCall(call) });
const reply = await client.chat({ agent: 'draft', messages, temperature: 0.2, signal: ctx.signal });
```

## In-process (TypeScript / JavaScript)

```js
// eval.config.mjs
export default { app: { module: './eval/app-adapter.mjs', export: 'run' } };
```

If your app already emits telemetry through a global sink, route it into the context for the duration of the call. Keep `concurrency` at 1 in that case, or calls from parallel runs mix. A sketch (the imported module and its fields stand for your own):

```js
import { runPipeline } from '../dist/pipeline/run-pipeline.js';
import { setTelemetrySink } from '../dist/infra/llm.js';

export async function run({ inputs, variant }, ctx) {
  setTelemetrySink((record) => ctx.recordLlmCall({
    agent: record.agentName, model: record.model, status: record.status, durationMs: record.durationMs,
    promptTokens: record.promptTokens, completionTokens: record.completionTokens,
    reasoningTokens: record.reasoningTokens, costUsd: record.costUsd,
  }));
  try {
    const result = await runPipeline(inputs.resume, inputs.jd, { model: variant.options.model });
    return {
      output: result.finalResume,
      lines: Object.fromEntries(result.finalResume.experience.map((role) => [role.company, role.bullets])),
      stages: result.stageModes,
      artifacts: { sourceRecord: result.sourceRecord },
      files: { 'resume.pdf': result.pdfBytes },
    };
  } finally {
    setTelemetrySink(null);
  }
}
```

The config itself may also be a function: `app: async (input, ctx) => ({ output: ... })`.

## Any language: a command

```js
export default { app: { command: ['python3', 'eval_adapter.py'], cwd: '.', env: { APP_MODE: 'eval' } } };
```

The command receives the input as JSON on stdin and writes the result as JSON on stdout (the last non-empty line is accepted if logs precede it). Write logs to stderr: they are streamed into the run log. A non-zero exit code is an error; a timeout kills the process.

Python:

```python
# eval_adapter.py
import json, sys, time
from myapp.pipeline import answer

case = json.load(sys.stdin)
calls = []
started = time.time()
reply, usage = answer(case["inputs"]["question"], case["inputs"]["context"], **case["variant"]["options"])
calls.append({"agent": "answer", "model": usage.model, "status": "ok",
              "durationMs": int((time.time() - started) * 1000),
              "promptTokens": usage.prompt_tokens, "completionTokens": usage.completion_tokens})
print(json.dumps({"output": reply, "llmCalls": calls}))
```

Swift, as a sketch: a separate executable target that links the app's core and drives the same session the app drives (`AppCore`, `MeetingSession` and `MetricsRecorder` stand for your own types):

```swift
// Sources/EvalAdapter/main.swift
import Foundation
import AppCore

struct Input: Decodable { let caseId: String; let inputs: [String: String]; let variant: Variant; let sample: Int }
struct Variant: Decodable { let name: String; let options: [String: String] }

let input = try JSONDecoder().decode(Input.self, from: FileHandle.standardInput.readDataToEndOfFile())
let recorder = MetricsRecorder()
let session = MeetingSession(model: input.variant.options["model"] ?? "default", metrics: recorder)
for line in input.inputs["transcript", default: ""].split(separator: "\n") { session.ingest(String(line)) }
let minutes = await session.summarize()
let result: [String: Any] = [
  "output": minutes ?? "",
  "gates": ["strict_schema": session.lastRoundPassedSchema, "materials_read": session.readMaterialsBeforeAnswering],
  "llmCalls": recorder.records.map(\.json),
]
FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result))
```

```js
export default { app: { command: ['swift', 'run', '-c', 'release', 'EvalAdapter'] } };
```

## A running service: HTTP

```js
export default { app: { url: 'http://localhost:4000/internal/eval', headers: { authorization: `Bearer ${process.env.EVAL_TOKEN}` } } };
```

The harness POSTs the input as JSON and expects the result as JSON. Expose such an endpoint only in development or behind authentication.

## Variants

Variants are named option sets passed to the adapter. Use them for what you compare:

```js
variants: {
  baseline: { model: 'vendor/model-a', reasoning: 'off' },
  candidate: { model: 'vendor/model-b', reasoning: 'off' },
  'candidate-low': { model: 'vendor/model-b', reasoning: 'low' },
}
```

`aieval run` runs the first variant unless `--variant a,b` or `--variant all` is given. Each variant × sample is a separate series in the report; compare any two with `<run>#<variant>`.
