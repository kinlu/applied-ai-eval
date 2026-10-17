# Methodology

How to evaluate an applied AI app so that every prompt, model or configuration change is adopted on evidence. Each rule below says what to do, why, and which failure it prevents. The tooling in this repository implements the rules; the rules work without it.

## The loop

```text
 write cases ─► baseline run ─► change one thing ─► candidate run ─► compare ─► judge both back to back
      ▲                                                                   │
      │                                      quality regressed? ──yes──► fix against the tuning cases
      │                                                                   │ no
      └──── add fresh hold-out cases ◄── record the decision ◄── hold-out acceptance run (once)
```

1. **Baseline.** Run the current app over the tuning cases, with two or more samples if the app samples.
2. **Change one thing.** A prompt, a model slug, a temperature, a retry or token budget, a guard rule. If two things change at once, the comparison cannot say which one did what.
3. **Candidate.** Run again with the same cases and sample count.
4. **Compare.** `aieval compare baseline candidate`. Read the verdict, the warnings, and every per-case change.
5. **Judge back to back**, if the change is about quality a check cannot see: `aieval judge` on both runs, in one sitting.
6. **Decide.** Adopt only if no quality metric regressed beyond its noise. Accept or reject each cost and latency trade-off explicitly, with the numbers, and write down who decided and why.
7. **Accept on the hold-out set**, once, at the end. Report what it shows.
8. **Paste the comparison** into the pull request.

## 1. Evaluate the production path, end to end

Run what a user's request runs: the same prompts, the same request protocol (structured output, tool calls, streaming), the same validators, guards, fallbacks, trimming and rendering. Measure the **final, user-visible output**, after every post-processing step.

Why: most regressions live between the model and the user. A guard that trims a resume to fit a page can delete the bullet the new prompt improved. A strict-schema protocol that one model satisfies and another does not fails in production, not in a playground. An eval that calls the model directly measures a different system.

How:

- The adapter calls the same entry point production calls (`runPipeline(input)`, not `callModel(prompt)`).
- Vary exactly one thing per comparison, ideally through a variant option (`{ model: 'x' }`, `{ prompt: 'v2' }`), so the rest of the path is byte-identical.
- If production has a deterministic fallback, the eval must see it fire: report each stage's mode (`llm`, `fallback`, …) so fallbacks are counted, not hidden.

## 2. Golden cases that can be failed

A case is a fictional, neutralised input set for one realistic scenario, plus the expectations a reviewer would check.

- **Cover the variety your users bring**: professions, document lengths, languages, edge structures (an overlong history, a career change, a resume without a summary, a meeting where nobody is named). Tag each case with what it exercises and say why in `notes`.
- **Plant traps.** Judging quality needs inputs where the interesting behaviour is available to be got wrong. Patterns that work:
  - a number restated on a different basis (taxed vs untaxed, monthly vs yearly, new vs existing customers);
  - a preference stated as a decision ("I lean towards the 22nd" vs "we decided the 22nd");
  - a claim the reference documents contradict (the user says 60 days, the policy says 30);
  - a condition that is easy to promise away ("not yet approved", "verified in three rebuilds, not on a device");
  - a participant who changes position halfway through;
  - a qualifier that is easy to drop ("about 60", "in the last two years", "at least 30 days");
  - a before→after improvement whose starting value is easy to drop ("from 10 days to 6");
  - a constraint the user did not ask about (a minimum seat count, a plan requirement).
- **Give every trap the cheapest deterministic test that catches it**, and a reviewer question for what a pattern cannot. Prefer asserting the correct statement (`mustInclude: ["30 days"]`) over forbidding the wrong one: a correct answer often quotes the wrong claim in order to correct it.
- **Gold is derived from the input, never from a model's output.** Hand-check it.
- **Only fictional, neutralised data**, in tuning and hold-out sets alike. Never real personal data, never a real customer's document "with the names changed".

See [writing-cases.md](writing-cases.md).

## 3. Tune on cases, accept on a hold-out set

Prompts, guard rules and thresholds get tuned against what you look at. After a few rounds the tuning cases stop measuring the app and start measuring how well you fitted them.

- Keep a hold-out set in **other scenarios** than the tuning set (other professions, other topics), run it **once at the end** of a change for acceptance, and report the result.
- **Never change code to fix one hold-out output.** If a hold-out run exposes a real problem, reproduce it with a tuning case and fix it there.
- **Reading a hold-out output burns that case.** Record it (`aieval holdout seen <case> --note "..."`): the next hold-out report lists which cases are no longer blind. Add fresh hold-out cases before the next acceptance run.
- Check that no hold-out case is a copy of a tuning case (`aieval holdout status` flags shared ids and identical inputs).

## 4. Deterministic checks first

Before asking a model what it thinks of an output, check what can be checked exactly. Grounding failures are the ones users trust most and catch least:

| Failure | Check |
|---|---|
| An invented figure ("cut costs by 40%", "within 24 hours") | every number must appear in an input |
| A plausible duty or promise the inputs never mention | every content word must appear in an input, after folding inflection |
| The answer parrots the request ("Owned the observability roadmap" from the job ad) | lines covered by the request but by no source sentence |
| The same fact said twice | near-duplicate pairs within a section |
| A measured change turned into a plain state | "from X to Y" kept as "Y" |
| A bounded fact made absolute | "about 60" → "60", "in the last two years" dropped |
| A misspelt name or term | near-misses of an input word |
| A fact the output had to keep | coverage of the case's `carry` list |

They are cheap enough to run on every output of every sample, exact enough to diff run over run, and they say *which line* is wrong. Calibrate their thresholds on outputs with known ground truth: in the app these checks come from, the coverage threshold was set on runs where the truth was known (output before and after a trim that only deletes), where surviving lines scored 1.00 and deleted ones at most 0.67, so the threshold sits in an empty band and is insensitive to its exact value. Recalibrate when your domain differs; [checks.md](checks.md) lists each threshold and its known limits.

## 5. Gates before quality

Some failures make an output unusable regardless of its text: the run errored or timed out, the structured output failed its schema, a required tool call never happened, the output came back in the wrong language or as JSON where prose was expected, a trap marked as a hard constraint failed. Report these as **gates**, pass or fail, in a table of case × variant × sample, before any quality metric. A model that fails a gate in your runtime is not a cheaper alternative; it is unavailable.

A gate can also fail for the setting rather than the model. When an endpoint rejects a parameter (for example, a model that refuses reasoning switched off), re-run that one stage with the setting one notch up before concluding the model is unusable.

## 6. Samples, not single runs

Model output is sampled. A difference seen once can be noise.

- Run **two or more samples per cell** when comparing models or prompts. Two samples separate structural differences (seconds versus a minute of latency, a failure in every sample) from one-offs; they do not give a failure *rate*. Say which you have.
- The comparison treats a change as real only when it exceeds the spread between samples (and the metric's tolerance).
- When a failure looks sporadic, re-run just that stage a few more times before calling it either reproducible or a fluke.

## 7. An LLM judge second, with measured noise

Some qualities need judgment: tone, whether the right experience was emphasised, whether the reply resolves the question. Use a judge, but treat its scores as noisy measurements:

- **Fix the judge model** across every run you compare; never let each candidate model judge itself.
- **Integer rubric**, 1–5, each dimension about one concrete property, temperature 0, JSON reply.
- **Judge baseline and candidate back to back** from their saved outputs (`aieval judge <run>`), not hours apart: scores drift between provider windows.
- **Measure the judge's noise** by judging identical outputs twice (`--passes 2`). In the app this comes from, the judge moved about ±0.16 per dimension on identical artifacts; a difference smaller than that is no difference.

See [judge.md](judge.md).

## 8. Compare, then decide

Every change ships with a before/after comparison: aggregates, per-agent tokens, per-case changes, judge deltas. The rule:

- **Adopt only if no quality metric regresses** beyond its noise.
- **Cost and latency are trade-offs, not verdicts.** A change can be worth 30% more tokens. Or a model can be "3–5 points lower on keyword coverage at the same cost and more faithful in a blind review", and a person decides that is acceptable. Write such a decision down with its numbers and who made it.
- Read the comparison's warnings: different case sets, changed inputs, different judge models, scores taken far apart, a smoke run on either side, different check definitions (re-score the older run first).

## 9. Count what it really costs

- **Use the cost the provider billed**, per call, when it reports one. List-price estimates are a fallback.
- **Count hidden reasoning tokens.** Some providers bill reasoning on top of the completion tokens they report, and in one comparison a model's reasoning tokens exceeded its visible output. Estimating from visible output systematically under-counts; report an upper bound that includes reasoning.
- **Failed calls can be billed without reporting usage** (a timeout or a dropped stream never returns the usage trailer). "Failed calls show zero cost" is not "the provider did not bill them".
- **Check the served model.** Routers can answer with a different model than requested. Record what the provider echoes and flag mismatches.
- **Latency is a gate for interactive features.** A real-time hint that arrives after the topic has moved on is a failure, however good its text.
- Two runs with similar total cost do not imply stable unit cost; compare per-run means on the same cases.

## 10. Keep every artifact

Store each output with the inputs it came from, its intermediate stages and its LLM calls. Then:

- **Re-score** saved runs when a metric definition, threshold or gold changes (`aieval rescore`), instead of paying to regenerate the baseline.
- **Re-judge** both runs with the same judge in the same window.
- **Re-render** or re-run a deterministic post-processing step on identical content when only that step changed: it isolates its effect from model noise.
- Diff outputs case by case when a metric moves.

Keep reports out of git: they contain model outputs.

## 11. A run without model calls is a smoke test

Without credentials, many apps fall back to deterministic paths. A run like that proves the harness works; it says nothing about output quality. The report says so, and the comparison warns about it. Never quote a smoke run as evidence for a prompt or model change.

## 12. Report honestly

A useful evaluation report has, in order:

1. **The conclusion in one sentence**, including what it costs ("more stable and much faster, needs one setting changed, costs 1.7–2.7× per session").
2. **What must change** for the conclusion to hold (a setting, a fallback).
3. **Gates**, then **quality** with evidence (case, file, the line that decides it), then **cost**.
4. **What was not verified**, plainly: samples per cell, endpoints and providers not covered, inputs never tried (real audio, long meetings), steps checked by inference rather than directly.
5. **How to reproduce it**: the exact command.

The review checklist each run writes (`review.md`) ends with *Findings* and *Not verified* sections for exactly this.

## Policy for your repository

Put the rules where your contributors (and coding agents) read them. [adopting.md](adopting.md) has a policy block for `AGENTS.md` / `CLAUDE.md`, a pull-request checklist and CI wiring.
