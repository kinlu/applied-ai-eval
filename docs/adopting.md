# Adopting the method in your repository

Tooling only helps if the rules are where contributors and coding agents read them. Copy the block below into your `AGENTS.md`, `CLAUDE.md` or `CONTRIBUTING.md` and adjust the paths.

## Policy block

```markdown
## LLM quality eval

- The offline eval lives in `eval/` (cases, hold-out set, adapter) and runs the production chain end to end;
  metrics are measured on the final, user-visible output. Run it with `npx aieval run`; reports land in
  `eval/reports/` (gitignored).
- Any change to generation logic MUST be validated with the eval before the work is complete: prompts,
  pipeline stages, guards and validators, fallbacks, post-processing, and LLM configuration (model,
  temperature, reasoning, token caps, retries, timeouts).
- For model selection, prompt changes or parameter tuning, run the eval before and after the change with the
  same cases and sample count (`--samples 2` or more when outputs are sampled) and diff the runs with
  `npx aieval compare <baseline> <candidate>`. Adopt the change only if no quality metric regresses beyond its
  noise; state cost and latency trade-offs with their numbers and who accepted them. Paste the comparison
  Markdown into the pull request.
- Judge scores: judge baseline and candidate back to back with `npx aieval judge <run>` rather than trusting
  scores taken hours apart; measure judge noise with `--passes 2`.
- When only metric definitions, thresholds or gold change, re-score saved runs with `npx aieval rescore <run>`
  instead of regenerating.
- Without LLM credentials the eval runs the deterministic path only: a harness smoke test, not a quality signal.
  A small `--case` subset is fine while iterating; run the full set for the final comparison.
- Hold-out set: tune only against `eval/cases/`. Run `npx aieval run --holdout` once at the end for acceptance
  and report the result. Never change code to fix an individual hold-out output; if you read one, record it with
  `npx aieval holdout seen <case> --note "..."`, fix the problem against `eval/cases/`, and add fresh hold-out
  cases before the next acceptance run.
- Cases contain only fictional, neutralised data. Never add real personal data to `eval/cases/` or `eval/holdout/`.
```

## Pull-request checklist

```markdown
### Eval
- [ ] Baseline and candidate runs on the same cases and samples: `eval/reports/<baseline>` → `eval/reports/<candidate>`
- [ ] No quality regression beyond noise (comparison below), or each regression explained and accepted by: …
- [ ] Cost / latency trade-offs: …
- [ ] Judged back to back (if the change targets judged qualities); judge noise: …
- [ ] Hold-out acceptance run: … (cases no longer blind: …)
- [ ] Not verified: …

<details><summary>aieval compare</summary>

(paste the Markdown)

</details>
```

## CI

A smoke run on every pull request keeps the harness and the deterministic path working without spending money. It cannot judge quality:

```yaml
# .github/workflows/eval-smoke.yml
name: eval smoke
on: [pull_request]
jobs:
  smoke:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: npm ci
      - run: npx aieval run --label smoke
```

A real-model comparison is better triggered on demand (a label or a manual dispatch) for pull requests that touch generation logic, with credentials from repository secrets. `--fail-on-regression` turns quality regressions into a failed job; cost and latency changes are listed but do not fail it:

```yaml
      - run: npx aieval run --variant baseline,candidate --samples 2 --label pr
        env: { OPENAI_API_KEY: '${{ secrets.OPENAI_API_KEY }}', OPENAI_MODEL: '${{ vars.OPENAI_MODEL }}' }
      - run: |
          RUN=$(ls -d eval/reports/*-pr | tail -1)
          npx aieval compare "$RUN#baseline" "$RUN#candidate" --out compare.md --fail-on-regression
      - if: always()
        uses: actions/upload-artifact@v4
        with: { name: eval-report, path: eval/reports/ }
```

Upload reports as build artifacts rather than committing them.
