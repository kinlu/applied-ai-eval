# Hold-out cases

Acceptance only: these cover topics the tuning cases in `../cases/` do not (sign-in, devices, discounts).
Tune prompts, rules and thresholds against `../cases/` and run these once at the end of a change:

```bash
npx aieval run --config examples/support-reply/eval.config.mjs --holdout --variant baseline,friendly
```

If you read a hold-out output to diagnose a problem, record it with
`npx aieval holdout seen <case> --note "why"`, fix the problem against `../cases/`, and add a fresh
hold-out case before the next acceptance run.
