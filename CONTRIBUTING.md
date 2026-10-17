# Contributing

Thanks for helping. Issues and pull requests are welcome, especially new checks backed by real failures,
adapters for other stacks, and calibration data.

## Develop

```bash
npm install          # Node 22+ for the test runner; the CLI itself runs on Node 20+
npm run typecheck
npm test
npm run example
```

## Adding or changing a check

1. Write the failing tests first: at least one output the check must flag and one it must not (the false
   positive you worry about most).
2. Implement it as a pure function in `src/checks/`, register it in `src/checks/index.ts` with a stable key,
   label, unit and direction (`better`).
3. Calibrate the threshold on outputs where the truth is known, and record how in a comment next to the
   constant and in `docs/checks.md`. A threshold that sits in an empty band between known-good and known-bad
   scores is worth more than a precise-looking one.
4. Document its limits (languages, known false positives).
5. Run the example before and after and include the comparison in the pull request.

## Ground rules

- No runtime dependencies.
- Fictional data only, in examples, tests and issues. Never paste real personal data or customer content.
- Keep the docs in step with behaviour: `README.md`, `README.zh-CN.md`, `docs/`.
