# Example: support-reply

A small applied AI app and its eval. The app drafts a reply to a customer of Quillbox, a fictional note-taking subscription, grounded in one help-centre article. Two prompt versions are compared:

- **baseline** (`prompt: 'grounded'`): answer only from the article; correct false premises; promise nothing beyond it.
- **friendly** (`prompt: 'friendly'`): be warm and reassuring. It reads better, and it is the kind of change that quietly agrees with a customer's wrong claim or over-promises.

| File | Purpose |
|---|---|
| [`app.mjs`](app.mjs) | the app under test, with its adapter `run()` |
| [`eval.config.mjs`](eval.config.mjs) | variants, sources, checks, judge rubric, tolerances |
| [`eval/cases/`](eval/cases) | six tuning cases, each with planted traps |
| [`eval/holdout/`](eval/holdout) | three acceptance-only cases on other topics |

## Run it offline

From the repository root, after `npm install`:

```bash
node dist/cli.js run --config examples/support-reply/eval.config.mjs --variant baseline,friendly
node dist/cli.js compare examples/support-reply/eval/reports/<run>#baseline examples/support-reply/eval/reports/<run>#friendly
```

Offline, a deterministic stand-in imitates each prompt's typical behaviour: the baseline extracts the relevant article sentences, the friendly version also agrees with the customer's most specific claim, restates a sentence and adds "We will sort this out for you within 24 hours, guaranteed." The run is labelled a smoke run: it demonstrates the harness, not either prompt's real quality.

What the comparison catches in the friendly version:

| Check | Why it fires |
|---|---|
| gate `trap:accepts-false-claim` | "You're right that your pricing page said annual plans can be refunded within 60 days." The article says 30. |
| `numbers.untraceable` | "24 hours" appears in no input |
| `lines.unsupported` | "guaranteed", "sort", "hours", "short", "right" appear in no input |
| `lines.echo` | the agreement line repeats the customer's message instead of answering from the article |
| `lines.nearDuplicates` | "In short, …" restates the previous sentence |

## Run it on a real model

```bash
export SUPPORT_REPLY_LLM=1 OPENAI_API_KEY=... OPENAI_MODEL=...      # OPENAI_BASE_URL for other OpenAI-compatible endpoints
node dist/cli.js run --config examples/support-reply/eval.config.mjs --variant baseline,friendly --samples 2

# Judge both variants from the saved outputs, twice, to measure the judge's noise.
export AIEVAL_JUDGE_MODEL=...                                        # a fixed judge, AIEVAL_JUDGE_API_KEY or OPENAI_API_KEY
node dist/cli.js judge examples/support-reply/eval/reports/<run> --passes 2
node dist/cli.js compare examples/support-reply/eval/reports/<run>-judged#baseline examples/support-reply/eval/reports/<run>-judged#friendly

# Once, at the end: acceptance on the hold-out set.
node dist/cli.js run --config examples/support-reply/eval.config.mjs --holdout --variant baseline
```

If a model call fails, the app falls back to the extractive draft and reports the stage as `fallback`, which the report counts.

## The cases

| Case | The trap |
|---|---|
| `refund-annual-after-six-weeks` | the customer quotes a 60-day refund window; the article says 30 days |
| `export-pdf-on-free-plan` | PDF export needs Pro, and one export holds at most 500 of the customer's 800 notes |
| `sync-conflict-after-offline-edit` | the customer hopes for an automatic merge the product does not do |
| `price-change-existing-subscriber` | prices on two bases (new vs existing, monthly vs yearly) and an "at least 30 days" notice qualifier |
| `account-deletion-timeline` | the customer demands same-day deletion; the policy gives 30 and 90 days |
| `team-seats-mid-cycle` | dropping to 2 seats runs into the 3-seat minimum the customer did not ask about |

Hold-out: `sso-password-reset`, `ios-widget-missing`, `student-discount-terms`. All names, companies and policies are fictional.
