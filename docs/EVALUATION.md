# Evaluation

**Question:** do AFTERCARE's Resolution Compiler and execution controls change outcomes compared with simpler agents that have the same tools?

**Answer on this scenario set:** yes, on all 22 scenarios. AFTERCARE reached the correct outcome in 22 of 22 with no safety violations. The baseline was correct in 11 of 22, and the careful baseline, which fixes the baseline's policy selection, retries and confirmation, in 16 of 22. The original 14 scenarios and the 8 added later (S15 to S22) are reported separately below. On the original 14 the results of AFTERCARE and the baseline are unchanged (14 and 7). Generated numbers are in [EVALUATION_RESULTS.md](EVALUATION_RESULTS.md), and machine-readable results are in [`data/evaluation/results.json`](../data/evaluation/results.json).

## How to reproduce

```bash
npm run eval
```

This rewrites both result files. The run is deterministic: no randomness reaches the scored output and no model is called. `tests/evaluation/evaluation.test.ts` fails if a fresh run differs from the committed JSON, or if the results of AFTERCARE and the baseline on S01 to S14 differ from the first published run (kept in `data/evaluation/results-original-14.json`).

## Setup

- **22 scenarios**, all evaluated on the pinned case date 2026-10-17: the original 14 (`src/evaluation/scenarios.ts`) and 8 added later (`src/evaluation/scenarios-extended.ts`). The labels of the added scenarios were committed before any strategy was run on them.
- **Ground truth** was written by hand from the fictional policy text in `data/seed/retailer.json`, not by running AFTERCARE. That text includes each version's scope clause ("applies to orders placed …"). Each label carries a `why` with the date arithmetic, so a reviewer can check it.
- **Isolation:** each strategy runs each scenario in a fresh SQLite database with a freshly seeded retailer sandbox. The sandbox is scripted per scenario (accept, refuse, unavailable, timeout before or after commit, and for S21 lookups that time out).
- **Scoring** combines three things: what the agent finally told the customer, what it submitted, and the retailer sandbox's own records (returns on file and the request log). Before final records are judged, the harness lets the retailer finish processing (`settle()`). An agent that never reads its return back is therefore not penalised in "correct outcome" for that alone.

### Scenario design

- **S01, S02:** policy-version selection. The order was placed under v2026.1, but the case is judged after v2026.2 (15 days) took effect.
- **S03, S05, S06:** correct denial and escalation.
- **S04, S07 to S14:** use an order both strategies agree is eligible (placed Oct 6, so v2026.2 governs). Each tests one control: a conflict, a recovery path, authorization, or missing information. In some of these (S04, S07, S08, S09, S11) the baseline reaches the right outcome anyway, and the only difference is whether it checked before claiming success.

| Category                   | Scenarios                                                     |
| -------------------------- | ------------------------------------------------------------- |
| Success                    | S02, S04                                                      |
| Blocked (correctly denied) | S03, S05                                                      |
| Conflicting evidence       | S06 (material), S07 (immaterial)                              |
| Failure recovery           | S01, S08, S09, S10, S11                                       |
| Authorization              | S12 (chat agreement only), S13 (terms changed after approval) |
| Missing information        | S14                                                           |

Added later (S15 to S22), to cover cases the first 14 did not:

| Scenario | What it tests                                                                     |
| -------- | --------------------------------------------------------------------------------- |
| S15, S16 | A kitchen item on the last day of its 30 day window, and one day after            |
| S17      | An order placed on Oct 1, the day v2026.2 took effect (15 days, closed)           |
| S18      | An order placed on Sep 30 and delivered after the change (v2026.1, 30 days, open) |
| S19      | Two matching orders; the customer reads the serial as `ha7q24471`                 |
| S20      | A change of mind stated in the first message (customer pays shipping)             |
| S21      | A lost response, then two return lookups that time out                            |
| S22      | Two eligible orders; only the serial says which pair the customer has             |

A retailer refusal was considered as a new case; S11 already covers it, so it was not duplicated.

## The baseline

A deterministic tool-calling agent. It uses the same retailer gateway and the same rules interpreter as AFTERCARE, without the compiler or execution controls. It:

- takes the most recent matching order;
- applies the currently published policy version;
- assumes "defective" when no reason is given;
- treats agreement in conversation as approval;
- reports the return confirmed as soon as the submission call returns;
- retries failures and timeouts with a new request, up to 3 attempts.

This baseline stands for a common, plausible design. **It is not a measurement of any particular LLM or product.** An LLM agent might do better or worse on any single behaviour. The comparison shows what each control prevents when it is absent.

## The careful baseline

A second deterministic agent, defined here before it was implemented or run, so the comparison does not rest on a baseline built to lose. It uses the same gateway and rules interpreter, and it fixes the three weaknesses of the first baseline that need no case model:

- it selects the policy version by the order date, using each version's scope clause, instead of the currently published one;
- it reuses one idempotency key for every attempt at the same submission, so a retry after a lost response cannot create a second return;
- it reads the return back before telling the customer anything: it reports "confirmed" only when the retailer's record says authorized, "refused" when the retailer refuses the request or the record says refused, and otherwise stops without a claim. It reads up to 5 times and counts a read that times out as one of them. Like the first baseline, it makes up to 3 submission attempts.

Everything else is the same as the first baseline. It has no explicit approval bound to a proposal digest (agreement in conversation counts as approval, and an approval is not withdrawn when the terms change), no authority policy for conflicting evidence (it uses the retailer's order record and ignores carrier scans), and no case state machine (it takes the most recent matching order and assumes "defective" when no reason is given).

## Metrics

| Metric                        | Definition                                                                                                                                                        |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Correct outcome               | The final message matches the ground truth **and** the settled retailer records agree (one authorized return on the required terms when expected; none otherwise) |
| Wrongful denial               | Said a return was impossible when the policy allows it                                                                                                            |
| Missed blocker                | Approved or denied when the evidence supported neither                                                                                                            |
| Authorization violation       | Submitted without the customer's explicit approval of the submitted proposal                                                                                      |
| Wrong terms submitted         | Submitted shipping terms that differ from what the policy requires for what the customer said                                                                     |
| Unsupported action            | Submitted a return for an order the policy does not allow, or while eligibility was unresolved                                                                    |
| Duplicate submission attempts | Requests with a new identity sent after the retailer had already created a return (events)                                                                        |
| Extra returns created         | Returns beyond one (events)                                                                                                                                       |
| Confirmed before verifying    | Said "confirmed" while the retailer's record, at that moment, did not yet show an authorized return                                                               |

## Results (measured)

Original scenarios (S01 to S14):

| Metric                        | AFTERCARE | Baseline | Careful baseline |
| ----------------------------- | --------: | -------: | ---------------: |
| Correct outcome               |   14 / 14 |   7 / 14 |           9 / 14 |
| Wrongful denials              |         0 |        2 |                0 |
| Missed blockers               |         0 |        1 |                1 |
| Authorization violations      |         0 |        2 |                2 |
| Wrong terms submitted         |         0 |        2 |                2 |
| Unsupported actions           |         0 |        0 |                1 |
| Duplicate submission attempts |         0 |        1 |                0 |
| Extra returns created         |         0 |        0 |                0 |
| Confirmed before verifying    |         0 |        7 |                0 |

Added scenarios (S15 to S22):

| Metric                        | AFTERCARE | Baseline | Careful baseline |
| ----------------------------- | --------: | -------: | ---------------: |
| Correct outcome               |     8 / 8 |    4 / 8 |            7 / 8 |
| Wrongful denials              |         0 |        2 |                0 |
| Missed blockers               |         0 |        0 |                0 |
| Authorization violations      |         0 |        0 |                0 |
| Wrong terms submitted         |         0 |        0 |                0 |
| Unsupported actions           |         0 |        1 |                1 |
| Duplicate submission attempts |         0 |        1 |                0 |
| Extra returns created         |         0 |        0 |                0 |
| Confirmed before verifying    |         0 |        3 |                0 |

All 22: AFTERCARE 22, baseline 11, careful baseline 16 correct outcomes.

What drives the baseline's 7 wrong outcomes on the original 14:

- **S01, S02 (wrongful denial):** it applies the newest policy instead of the version whose scope covers the order date.
- **S06 (missed blocker):** it denies using one delivery date, while an equally authoritative record gives another date that would allow the return.
- **S10 (duplicate attempt):** it resubmits after a lost response. The sandbox refuses the second request (one open return per item), and the baseline then tells the customer the return was refused although it exists.
- **S12 (authorization violation):** it treats "yes, go ahead" as approval and submits.
- **S13 (authorization violation, wrong terms):** it submits the faulty-item terms the customer had withdrawn.
- **S14 (wrong terms):** it assumes "defective" and submits a prepaid label for a change-of-mind return.

On the added scenarios the baseline denies S18 and S19 (newest policy again), creates a duplicate attempt in S21 and then reports a refusal, and returns the wrong pair in S22.

The careful baseline fixes S01, S02 and S10 and never confirms before reading the return back. Its 6 wrong outcomes come from what it still lacks:

- **S03, S22 (unsupported action):** it takes the most recent matching order instead of asking which item the customer has. In S03 that order is the newer pair while the customer has the older one; in S22 both are eligible and it returns the wrong one.
- **S06 (missed blocker):** it ignores the carrier's record and denies.
- **S12, S13 (authorization violation):** it takes conversation as approval, and keeps an approval after the terms changed.
- **S14 (wrong terms):** it assumes "defective" when no reason is given.

AFTERCARE was correct on every added scenario. None of them exposed a defect, so no fix was made for this evaluation.

**Confirmed before verifying** is a separate behaviour, not counted as a wrong outcome. The sandbox creates returns in a `processing` state and authorizes them on the next read. The baseline tells the customer "confirmed" on acknowledgement, without reading the return back. In this sandbox every such return was later authorized. With a retailer that sometimes rejects after acknowledging, the same behaviour would produce false confirmations. The careful baseline reads back first, which is why its count is 0.

## Limitations of this evaluation

- **Small and synthetic.** 22 hand-built scenarios on one fictional retailer and two product families. These are behavioural tests, not statistical estimates. No confidence intervals are claimed.
- **Written by the same team that built the system.** The ground truth is independent of the engine's code, but the scenario choice is not independent of the design. These are the behaviours AFTERCARE was built to handle. The 8 added scenarios were labelled before any run, but by the same team.
- **The sandbox's realism is a modelling choice.** "Processing until read" and "one open return per item" are plausible retailer behaviours we chose. A different retailer would change some baseline counts.
- **Not measured here:** latency, cost, customer satisfaction, and behaviour with a language model in the loop. All three strategies use the same rules interpreter. The optional model interpreter is measured separately, on field extraction only, in [INTERPRETER_EVALUATION.md](INTERPRETER_EVALUATION.md).
