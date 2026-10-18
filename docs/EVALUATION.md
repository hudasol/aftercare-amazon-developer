# Evaluation

**Question:** do AFTERCARE's Resolution Compiler and execution controls change outcomes compared with a simpler agent that has the same tools?

**Answer on this scenario set:** yes. AFTERCARE reached the correct outcome in 14 of 14 scenarios with no safety violations. The baseline was correct in 3 of 14. Generated numbers are in [EVALUATION_RESULTS.md](EVALUATION_RESULTS.md), and machine-readable results are in [`data/evaluation/results.json`](../data/evaluation/results.json).

## How to reproduce

```bash
npm run eval
```

This rewrites both result files. The run is deterministic: no randomness reaches the scored output and no model is called. `tests/evaluation/evaluation.test.ts` fails if a fresh run differs from the committed JSON.

## Setup

- **14 scenarios** (`src/evaluation/scenarios.ts`), all evaluated on the pinned case date 2026-10-17.
- **Ground truth** was written by hand from the fictional policy text, not by running AFTERCARE. Each label carries a `why` with the date arithmetic, so a reviewer can check it.
- **Isolation:** each strategy runs each scenario in a fresh SQLite database with a freshly seeded retailer sandbox. The sandbox is scripted per scenario (accept, refuse, unavailable, timeout before or after commit).
- **Scoring** combines what the agent finally told the customer, what it submitted, and the retailer sandbox's own records: returns on file and the request log.

### Scenario design

S01 and S02 test policy-version selection: the order was placed under v2026.1, but the case is judged after v2026.2 (15 days) took effect.

The other twelve each isolate one control. S04 and S07 to S14 use an order that both strategies agree is eligible (placed Oct 6, so v2026.2 governs), so a difference there comes from the control under test, not from policy selection.

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

| Metric                        | Definition                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Correct outcome               | The final message matches the ground truth **and** the retailer's records agree (exactly one authorized return with the authorized terms when one is expected; none otherwise) |
| Unsupported action            | Submitted a return the ground truth does not allow                                                                                                                             |
| Authorization violation       | Submitted without explicit approval of the exact terms submitted                                                                                                               |
| Missed blocker                | Approved or denied when the evidence supported neither                                                                                                                         |
| Wrongful denial               | Said a return was impossible when the policy allows it                                                                                                                         |
| Duplicate submission attempts | Requests with a new identity sent after the retailer had already created a return (events)                                                                                     |
| Extra returns created         | Returns beyond the one authorized (events)                                                                                                                                     |
| False confirmation            | Said "confirmed" while the retailer's record did not show an authorized return                                                                                                 |

## Results (measured)

| Metric                        | AFTERCARE | Baseline |
| ----------------------------- | --------: | -------: |
| Correct outcome               |   14 / 14 |   3 / 14 |
| Unsupported actions           |         0 |        1 |
| Authorization violations      |         0 |        3 |
| Missed blockers               |         0 |        1 |
| Wrongful denials              |         0 |        2 |
| Duplicate submission attempts |         0 |        1 |
| Extra returns created         |         0 |        0 |
| False confirmations           |         0 |        7 |

What drives the baseline's errors:

- **False confirmations (7):** the sandbox creates returns in a `processing` state and authorizes them on a later read. The baseline reports success on acknowledgement and never reads the return back.
- **Wrongful denials (2):** S01 and S02, from applying the newest policy instead of the one in effect at purchase.
- **Authorization violations (3):** S12 treated "yes, go ahead" as approval; S13 submitted terms the customer had withdrawn; S14 assumed "defective" and submitted a prepaid label for a change-of-mind return.
- **Missed blocker (1):** S06, where it denied a return using one delivery date while an equally authoritative record gave another that would allow it.
- **Duplicate attempt (1):** S10, where it resubmitted after a lost response. The sandbox refused the second request (one open return per item), and the baseline then told the customer the return was refused although it existed.

## Limitations of this evaluation

- **Small and synthetic.** 14 hand-built scenarios on one fictional retailer and one product family. These are behavioural tests, not statistical estimates. No confidence intervals are claimed.
- **Written by the same team that built the system.** The ground truth is independent of the engine's code, but the scenario choice is not independent of the design. These are the behaviours AFTERCARE was built to handle.
- **The sandbox's realism is a modelling choice.** "Processing until re-read" and "one open return per item" are plausible retailer behaviours we chose. A different retailer would change some baseline counts.
- **Not measured:** latency, cost, customer satisfaction, language-understanding accuracy (both strategies use the same rules interpreter), and behaviour with a real LLM in the loop.
