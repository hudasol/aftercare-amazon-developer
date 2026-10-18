# Evaluation

**Question:** do AFTERCARE's Resolution Compiler and execution controls change outcomes compared with a simpler agent that has the same tools?

**Answer on this scenario set:** yes. AFTERCARE reached the correct outcome in 14 of 14 scenarios with no safety violations. The baseline was correct in 7 of 14. Generated numbers are in [EVALUATION_RESULTS.md](EVALUATION_RESULTS.md), and machine-readable results are in [`data/evaluation/results.json`](../data/evaluation/results.json).

## How to reproduce

```bash
npm run eval
```

This rewrites both result files. The run is deterministic: no randomness reaches the scored output and no model is called. `tests/evaluation/evaluation.test.ts` fails if a fresh run differs from the committed JSON.

## Setup

- **14 scenarios** (`src/evaluation/scenarios.ts`), all evaluated on the pinned case date 2026-10-17.
- **Ground truth** was written by hand from the fictional policy text in `data/seed/retailer.json`, not by running AFTERCARE. That text includes each version's scope clause ("applies to orders placed …"). Each label carries a `why` with the date arithmetic, so a reviewer can check it.
- **Isolation:** each strategy runs each scenario in a fresh SQLite database with a freshly seeded retailer sandbox. The sandbox is scripted per scenario (accept, refuse, unavailable, timeout before or after commit).
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

## The baseline

A deterministic tool-calling agent. It uses the same retailer gateway and the same rules interpreter as AFTERCARE, without the compiler or execution controls. It:

- takes the most recent matching order;
- applies the currently published policy version;
- assumes "defective" when no reason is given;
- treats agreement in conversation as approval;
- reports the return confirmed as soon as the submission call returns;
- retries failures and timeouts with a new request, up to 3 attempts.

This baseline stands for a common, plausible design. **It is not a measurement of any particular LLM or product.** An LLM agent might do better or worse on any single behaviour. The comparison shows what each control prevents when it is absent.

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

| Metric                        | AFTERCARE | Baseline |
| ----------------------------- | --------: | -------: |
| Correct outcome               |   14 / 14 |   7 / 14 |
| Wrongful denials              |         0 |        2 |
| Missed blockers               |         0 |        1 |
| Authorization violations      |         0 |        2 |
| Wrong terms submitted         |         0 |        2 |
| Unsupported actions           |         0 |        0 |
| Duplicate submission attempts |         0 |        1 |
| Extra returns created         |         0 |        0 |
| Confirmed before verifying    |         0 |        7 |

What drives the baseline's 7 wrong outcomes:

- **S01, S02 (wrongful denial):** it applies the newest policy instead of the version whose scope covers the order date.
- **S06 (missed blocker):** it denies using one delivery date, while an equally authoritative record gives another date that would allow the return.
- **S10 (duplicate attempt):** it resubmits after a lost response. The sandbox refuses the second request (one open return per item), and the baseline then tells the customer the return was refused although it exists.
- **S12 (authorization violation):** it treats "yes, go ahead" as approval and submits.
- **S13 (authorization violation, wrong terms):** it submits the faulty-item terms the customer had withdrawn.
- **S14 (wrong terms):** it assumes "defective" and submits a prepaid label for a change-of-mind return.

**Confirmed before verifying (7)** is a separate behaviour, not counted as a wrong outcome. The sandbox creates returns in a `processing` state and authorizes them on the next read. The baseline tells the customer "confirmed" on acknowledgement, without reading the return back. In this sandbox every such return was later authorized. With a retailer that sometimes rejects after acknowledging, the same behaviour would produce false confirmations.

## Limitations of this evaluation

- **Small and synthetic.** 14 hand-built scenarios on one fictional retailer and one product family. These are behavioural tests, not statistical estimates. No confidence intervals are claimed.
- **Written by the same team that built the system.** The ground truth is independent of the engine's code, but the scenario choice is not independent of the design. These are the behaviours AFTERCARE was built to handle.
- **The sandbox's realism is a modelling choice.** "Processing until read" and "one open return per item" are plausible retailer behaviours we chose. A different retailer would change some baseline counts.
- **Not measured:** latency, cost, customer satisfaction, language-understanding accuracy (both strategies use the same rules interpreter), and behaviour with a real LLM in the loop.
