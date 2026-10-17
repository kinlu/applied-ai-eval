# Writing cases

A case is one realistic scenario: the inputs the app receives, and what a reviewer expects of the output. Cases live in one directory each:

```text
eval/
├── cases/                 tuning cases: iterate against these
│   └── refund-after-window/
│       ├── case.json
│       ├── message.txt
│       ├── kb.md
│       └── gold.json      optional: expected values for app-specific metrics
└── holdout/               acceptance only: other scenarios, run once at the end
    └── sso-password-reset/
        └── ...
```

The directory name is the case id unless `case.json` sets `id`. Directories starting with `_` or `.` are skipped, so `_draft-case/` can sit there unfinished.

## case.json

| Field | Meaning |
|---|---|
| `title` | One line a reviewer reads first. |
| `tags` | What the case exercises (`numbers`, `false-premise`, `overlong-input`); filter with `--tag`. |
| `notes` | Why the case exists and which mistake it makes available. |
| `inputs` | Named inputs passed to the app. A value is literal JSON, or `{ "file": "name.txt" }` to read a file next to case.json (`.json` files are parsed). Without `inputs`, every file in the directory except case.json and gold.json becomes an input named after the file. |
| `sources` | Inputs the output may be grounded in. Defaults to the config's `sources`, else every input. |
| `echoOf` | Inputs the output should answer rather than repeat (the user's request, a job ad). |
| `traps` | Planted traps, see below. |
| `carry` | Facts from the inputs the output must keep; each is checked for coverage by some output line. |
| `keywords` | Terms the output is expected to contain. |
| `review` | Extra questions for the human review checklist. |
| `allow` | `{ "numbers": [...], "words": [...] }` the output may use although no input does (a hotline number, the product name). |
| `gold` | Expected values for app-specific metrics, inline or `{ "file": ... }`; `gold.json` is loaded automatically. Never passed to the app. |
| `seen` | Hold-out only: written by `aieval holdout seen`, one entry per time the outputs were read. |

The app receives only `caseId`, `inputs`, `variant` and `sample`, never gold, traps or review questions.

## Traps

```json
{
  "id": "accepts-false-claim",
  "description": "Must not agree that annual plans are refundable within 60 days.",
  "mustNotMatch": ["refund(?:ed|s)? within 60 days", "\\byou(?:'re| are) (?:right|correct)\\b"],
  "gate": true,
  "review": "Does the reply correct the 60-day claim politely?"
}
```

| Field | Meaning |
|---|---|
| `mustInclude` | Literal substrings, case-insensitive; all must appear. Use these for prices and phrases with regex characters (`$84`, `(conflicted copy)`). |
| `mustNotInclude` | Literal substrings that must not appear. |
| `mustMatch` | Regular expressions (flags `iu`); all must match. Put alternatives inside one pattern with `|`. |
| `mustNotMatch` | Regular expressions that must not match. |
| `gate` | A failure also fails the run's gate `trap:<id>`: use it for hard constraints (a promise the policy forbids). |
| `review` | The question for the reviewer; defaults to the description. |

Patterns that work:

- **Assert the correct statement** rather than forbid the wrong one. `mustInclude: ["30 days"]` is robust; `mustNotMatch: ["60 days"]` also fails the correct reply "the window is 30 days, not 60".
- **Negations defeat regexes.** "doesn't merge them automatically" contains "merge them automatically". Assert the negated form instead: `"(?:does not|doesn't|won't|cannot|can't) (?:automatically )?merge"`.
- **Forbid phrases a correct output never needs**: sycophantic agreement ("you're right") with a false premise, a promise verb next to a forbidden commitment.
- **One trap per mistake**, so the report says which one happened.
- Each trap tests the output text; when the output is structured, the text is every string in it (or the `text` your adapter returns).

## Designing a case set

- **Variety over volume.** Fifteen cases that each exercise something different beat a hundred near-copies. Cover lengths (a sparse input, an overlong one), structures (missing sections, unusual layouts), languages, and the professions or topics your users actually bring.
- **Make every case able to fail.** If no plausible model could get a case wrong, it only adds cost. Plant at least one trap per case (see the patterns in [methodology.md](methodology.md#2-golden-cases-that-can-be-failed)).
- **Write fixtures by hand.** A templated generator produces cases that all say the same thing in the same shape: useful for measuring prompt growth or cost, useless for judging quality.
- **Derive gold from the input**, by hand, and keep it checkable: verbatim lines, exact dates, the list of roles.
- **Record intent.** `notes` should say what the case is for; when a case stops earning its place, delete it.

## The hold-out set

- Put it in other scenarios than the tuning set covers (other professions, other topics), with the same file format.
- Run it once at the end of a change: `aieval run --holdout --variant <candidate>`.
- If you read a hold-out output to diagnose a problem, record it: `aieval holdout seen <case> --note "read while checking the widget answer"`. Fix the problem against a tuning case, and add a fresh hold-out case before the next acceptance run.
- `aieval holdout status` lists blind and seen cases and flags hold-out cases that share an id or identical inputs with a tuning case.

## Privacy

Cases are committed to the repository and sent to model providers on every run. Write them as fiction: invented people, companies, numbers and documents, with no real personal data, customer content or internal documents, not even "with the names changed". Keep run reports, which contain model outputs, out of git.
