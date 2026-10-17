# Checks

Every check compares the output with the inputs the app was given; none calls a model. Configure them in `checks` (defaults below); each accepts the options listed. Case expectations (traps, keywords, carry) always run.

Defaults: `numeric-traceability`, `unsupported-lines`, `near-duplicates`, `input-echo`, `misspellings`, `baseline-drops`, `qualifier-drops`, `reasoning-leak`, `length`.

```js
checks: [
  'numeric-traceability',
  { check: 'unsupported-lines', allow: ['Quillbox'] },
  { check: 'input-echo', echoOf: ['jd'], minCoverage: 0.7 },
  { check: 'schema', schema: replySchema },
  { check: 'script-ratio', script: 'han', min: 0.6 },
]
```

## What the checks read

- **Text**: the adapter's `text`, else the output when it is a string, else every string in the output.
- **Lines**: the adapter's `lines` (an array, or named groups such as one per section or role), else the text split into lines and sentences with list markers, emphasis and table pipes removed; Markdown headings, rules and code fences are skipped. Override with `segment` in the config.
- **Sources**: the inputs named by the check's `sources` option, else the case's `sources`, else the config's `sources`, else every input.

Text is compared on content tokens: lower-cased words with crude suffix stripping, and overlapping character bigrams for Chinese, Japanese and Korean. Thresholds were calibrated on English output.

## Grounding

### `numeric-traceability`

Numbers the output states that no source states: money, percentages, multipliers, counts. `"$1.4M"`, `"1,400,000"` and `"1.4"` compare by their numeric core, so formatting differences pass.

- Keys: `numbers.untraceable` (count, lower is better), `numbers.traceable` (share of the output's distinct numbers found in a source; N/A when the output has none).
- Options: `sources`, `allow` (numbers allowed anyway). Cases can add `allow.numbers`.
- Limits: a number that appears in a source in another role still counts as traceable (the check proves the figure exists, not that it is used correctly); traps catch wrong bases.

### `unsupported-lines`

Lines that use a content word no source uses: the padded duty, the invented guarantee. Inflection and derivation are folded ("led"/"leads", "coordination"/"coordinated"), compounds compare part by part, and framing words that add no fact ("owned", "collaborated", "team", "thanks") are ignored.

- Key: `lines.unsupported`; examples list each line with its unsupported words in brackets.
- Options: `sources`, `allow` (domain words such as the product name). Cases can add `allow.words`.
- Calibration: on resume output, about 3.5% of lines were flagged, roughly one per resume, mostly embellishments; every known invented duty was caught.
- Limits: English only (CJK text is never flagged). The framing list was built for professional prose; extend `allow` for your domain rather than treating every flag as a defect.

### `input-echo`

Lines that parrot an input the output should answer rather than repeat: one statement of the echoed input covers ≥ 0.7 of the line's content while no source sentence covers ≥ 0.5. A line that borrows the request's wording for a fact the sources state is not flagged.

- Key: `lines.echo`. Runs only when `echoOf` names at least one input (option, case or config).
- Options: `echoOf`, `sources` (default: every source except the echoed inputs), `minCoverage`, `maxSourceCoverage`.

### `near-duplicates`

Line pairs that restate each other within one group: content overlap ≥ 0.6 and either at least 4 shared content tokens or one line wholly inside the other. Short sibling lines that only share a frame ("Prepared accruals for 15 entities" / "Prepared journals for 15 entities") do not count.

- Key: `lines.nearDuplicates`. Return named `lines` groups from the adapter to keep pairs within a section (the same achievement can legitimately appear under two jobs).
- Option: `minOverlap`.
- Limits: lexical. Two different statements about the same subject can pair up ("refundable within 30 days" / "after 30 days, cancel and keep the plan"); read the examples before acting on a count.

### `misspellings`

Words absent from every input yet one edit (insertion, deletion, substitution, or a swap of adjacent letters) from an input word, with the edit inside the word rather than in its last two characters and both words at least 6 characters long; plus input words split by a stray space ("U KG" for "UKG"). Rewording is the app's job, so a word merely absent from the inputs is not a defect; a near-miss of one is.

- Key: `text.misspellings`. Option: `sources` (default: every input).
- Calibration: at minimum length 6, 3 tokens flagged in 27 runs, all genuine; at 5, irregular forms ("drove"/"drive") came back.
- Limits: Latin-script words only.

### `baseline-drops`

A line that restates a source improvement ("from 10 business days to 6") and keeps the result but not the starting value, so a measured change reads as a plain state. Every number stays traceable, which is why numeric traceability misses it.

- Key: `numbers.baselineDrops`. English only.

### `qualifier-drops`

A line that states a source fact without the qualifier that limits it: a time window ("in the last two years", "since 2019") or an approximation or bound ("about 60", "up to", "at least"). A kept qualifier or a range passes.

- Key: `numbers.qualifierDrops`. English only.

## Format

### `reasoning-leak`

The model's own reasoning in user-visible text: `<think>`, "As an AI", "Let me think", "The user wants", "首先我", "用户要求", … The default list is deliberately short ("Let me know" is ordinary in a reply).

- Key: `text.reasoningLeaks`. Options: `markers` (replace the list), `extend` (add to it). Add the leaks your app has actually shown.

### `json-shape`

Prose that came back as a JSON object, an array or a fenced json block.

- Key: `text.jsonShape`. Option: `gate: true` adds the gate `prose`.

### `script-ratio`

The share of letters written in the expected script: `latin`, `han`/`chinese`, `japanese`, `kana`, `korean`/`hangul`, `cyrillic`, `greek`, `arabic`, `hebrew`, `devanagari`, `thai`. For non-Latin scripts it also counts runs of six or more consecutive English words (a sentence that slipped into English; model ids and file names are shorter).

- Keys: `text.scriptRatio`, `text.foreignRuns`. Options: `script` (required), `min` (adds the gate `script`).

### `length`

Output length in characters (code points) or words. Not good or bad by itself, but a large change is worth reading: it is often padding.

- Key: `text.length`. Options: `unit: 'words'`, `min`, `max` (bounds add the gate `length`).

### `schema`

Validates structured output (or a string output parsed as JSON, fences allowed) against a JSON Schema. Supports `type` (and type lists), `enum`, `const`, `properties`, `required`, `additionalProperties`, `items`, `minItems`, `maxItems`, `minLength`, `maxLength`, `pattern`, `minimum`, `maximum` and `anyOf`; unknown keywords are ignored, so you can pass the schema you send to the model.

- Key: `schema.errors`, gate `schema`. Options: `schema` (required), `field` (a dot path into the output).

## Case expectations

| Case field | Keys | Notes |
|---|---|---|
| `traps` | `traps.failed`, gates `trap:<id>` for traps with `gate: true` | see [writing-cases.md](writing-cases.md#traps) |
| `keywords` | `keywords.coverage`, `keywords.missing` | every word of a multi-word term must appear, inflection folded |
| `carry` | `carry.coverage`, `carry.missing` | a fact counts as carried when one output line covers ≥ 0.5 of its content tokens |

The 0.5 carry threshold was calibrated on runs with known ground truth: output before and after a trim that only deletes. Surviving lines scored 1.00 and deleted lines at most 0.67 (p95 0.38), so the threshold sits in an empty band and is insensitive between 0.4 and 0.7.

## Recorded for every run

| Key | Meaning |
|---|---|
| `runs.failed` | the app threw or timed out |
| `gates.failedRuns`, `gate.<name>` | runs with any failed gate; pass rate per gate (`completed` fails on errors, timeouts and empty output) |
| `stages.fallbacks` | stages whose mode is in `fallbackModes` (default `fallback`, `deterministic`) |
| `llm.errors` | failed LLM calls, including retried ones |
| `llm.calls`, `llm.promptTokens`, `llm.completionTokens`, `llm.reasoningTokens` | per run (usage) |
| `llm.costUsd` | billed cost per run, from the provider |
| `llm.estimatedCostUsd` | list price from `pricing`; the report also shows an upper bound counting reasoning tokens |
| `llm.timeMs`, `run.durationMs`, `run.durationMs.p50/p90/max` | latency (usage) |
| `judge.<dimension>` | judge scores, when judged |

A failed, timed-out or empty run gets no quality measurements, so a failure can never read as clean output; it shows up in `runs.failed` and the `completed` gate instead.

## Your own metrics

Return `metrics` from the adapter, or add `metrics` to the config:

```js
metrics: [{
  key: 'import.roleRecall',
  label: 'Roles recovered from the source',
  unit: 'ratio',
  better: 'higher',
  measure: ({ case: c, result }) => {
    const gold = c.gold.roles.map((role) => role.company);
    const found = result.output.experiences.map((role) => role.company);
    return gold.filter((company) => found.includes(company)).length / gold.length;
  },
}]
```

Set `better` (`higher`, `lower` or `none`) so the comparison can give a verdict, and `kind: 'usage'` for cost-like metrics. Counts are summed across cases; everything else is averaged (override with `aggregate`).
