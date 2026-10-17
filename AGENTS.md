# AGENTS.md

applied-ai-eval: a methodology and a zero-dependency TypeScript toolkit for evaluating applied AI apps on golden
cases. `README.md` is the overview, `docs/` holds the method and every reference, `CONTRIBUTING.md` the workflow.

## Layout

- `src/checks/`: the deterministic checks (`text.ts` primitives, `vocabulary.ts`, `grounding.ts`, `format.ts`,
  `schema.ts`, `traps.ts`) and their registry (`index.ts`). Pure functions, no I/O.
- `src/measure.ts`: scores one case run (checks, case expectations, gates, fallbacks, app metrics).
- `src/runner.ts` (`aieval run`), `src/compare.ts`, `src/judge.ts`, `src/rescore.ts`, `src/holdout.ts`,
  `src/init.ts`, `src/cli.ts`; `src/aggregate.ts` and `src/report.ts` build aggregates and Markdown.
- `src/adapters.ts` (module / command / HTTP), `src/llm.ts` (OpenAI-compatible client), `src/telemetry.ts`.
- `examples/support-reply/`: a runnable fictional app with tuning and hold-out cases.
- `test/`: Vitest unit and end-to-end tests.

## Commands

```bash
npm install          # also builds dist/
npm run typecheck
npm test
npm run example      # the example, offline, both variants
```

## Rules

- Behaviour changes to checks, measurement, aggregation or comparison come with tests first, and with a run of
  the example before and after (`npm run example`, then `node dist/cli.js compare`).
- A new or changed threshold needs evidence: say what it was calibrated on and keep that note next to the
  constant and in `docs/checks.md`.
- No runtime dependencies. Node built-ins only.
- Examples and test fixtures contain only fictional data.
- Keep `README.md`, `README.zh-CN.md` and `docs/` in step with the CLI, the case format and the checks.
