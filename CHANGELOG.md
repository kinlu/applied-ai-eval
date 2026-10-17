# Changelog

## 0.1.0

First release.

- `aieval run`: variants × samples × golden cases through a module, command or HTTP adapter; report.json,
  report.md, inputs.md, review.md and every artifact per run; smoke-run and hold-out labelling.
- Deterministic checks: numeric traceability, unsupported lines, near-duplicates, input echo, misspellings,
  dropped baselines and qualifiers, reasoning leaks, JSON shape, script ratio, length, JSON Schema gate;
  case traps, keywords and facts to carry.
- Telemetry: LLM calls, tokens, reasoning tokens, billed and list-price cost with an upper bound, latency
  percentiles, served-model mismatches, fallbacks.
- `aieval compare` with per-metric verdicts beyond tolerance, sample spread and judge noise;
  `--fail-on-regression`.
- `aieval judge` (post hoc, back to back, `--passes` for judge noise), `aieval rescore`, `aieval holdout`,
  `aieval init`.
- Example app `examples/support-reply` with six tuning cases and three hold-out cases.
