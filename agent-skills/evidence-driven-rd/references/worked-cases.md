# Worked cases from the supplied history

These are examples of applying the procedure to actual recorded cases, not mandatory domain tools or numeric thresholds. Physical line references identify the original JSONL records; provenance and limitations are in `process-evidence.md`.

## Case 1 — A known answer retrieved from a full archive

**Input.** The original request counts only complete 256-bit matches as success (L248). A subsequent full-corpus search reports 193,978 exact matches (L518). The query is a stored previous hash; its corresponding own hash is itself in the archive (L526).

**Procedure.**

1. Preserve the exact-match criterion and state the query and corpus definition.
2. Trace the target to the corresponding stored record before interpreting the match rate.
3. Classify the result as retrieval of an existing answer. It does not establish recovery of an unknown future value.
4. If the next experiment removes the direct answer, inspect related records and temporal availability as well. L577 still reports neighbors from the future.
5. Keep the full archive for descriptive research when requested. For a prediction claim, define which records and features could actually exist at prediction time.

**Supported output.** “The exact retrieval succeeded in this corpus. Future prediction remains untested by that result.” If a no-self run has zero exact matches, report zero; its smaller mean distance remains a different metric.

**Stop/escalate condition.** Do not run a new predictive experiment during an analysis-only request. State the missing availability contract; do not silently convert the experiment.

## Case 2 — An apparent rejection discovery explained by a compatible control

**Input.** Historical valid pairs have 91.733% coverage of a distance region (L1587). A separate candidate experiment reports 9.92% accepted with ten trials (L2490). Later code accepts candidates only with at least five successes among one hundred trials (L2596), with approximately 0.37% accepted reported by the user (L2578). The final response substitutes historical coverage for arbitrary-output probability (L2674).

**Procedure.**

1. Identify the two selection events: historical valid outputs versus generated candidate outputs. Their probabilities need not agree.
2. Read the actual predicate and trial rule. “At least once among ten” and “at least five among one hundred” are different events.
3. Define an explicit control, without declaring its assumptions facts about the real generator. Under uniform independent 256-bit outputs, distance to a fixed reference is binomial with 256 trials and probability 1/2.
4. Compute the region probability and then the candidate-passage event. Do not use the historical coverage as the unconditional region probability.

**Executed control calculation from the prior review.** `p = Σ(k=69..109) C(256,k)/2^256 = 0.010284725520810178`; `1−(1−p)^10 = 0.09821557805834524`; and `P(Binomial(100,p)≥5) = 0.0038630063664778155`.

**Supported output.** The 9.82% and 0.386% control values are close to the recorded 9.92% and approximately 0.37%; passage rates alone are insufficient evidence of an extra dependence. This neither proves implementation correctness nor rules out all other relations. The original “breakthrough” and subsequent “must be a bug” interpretations both need reevaluation.

**Forward check.** Examine actual useful outcomes and verify the control assumptions on the relevant task before claiming any practical filter. Read `scientific-methods.md` for the scientific reference when explaining the distribution.

## Case 3 — A cheap-looking filter with a simulated expensive stage

**Input.** The visible code marks full cost as `simulated` and computes it from prefilter time (L2596):

```python
t_full_simulated = t_prefilter * 10
t_full_total += t_full_simulated * admissible
```

The observed rejection count is not a count of useful solutions preserved.

**Procedure.**

1. Separate actual prefilter timing from the assumed full-stage multiplier.
2. Identify which operation the filter requires and whether the supposedly avoided result is already computed in it.
3. Establish the comparable baseline budget and useful final success criterion.
4. Determine whether rejected candidates contain valid solutions; distinguish sample rejection from a universal impossibility claim.
5. If the required real costs or useful-outcome counts are absent, report the gap. Propose measurement; do not report a real speedup from the simulated total.

**Supported output.** “The record measures the prefilter but estimates the full-stage cost. End-to-end acceleration and valid-solution retention have not been established.” The next justified experiment measures comparable complete workloads with the original success criterion.

## Case 4 — A corrected relation must change what the next experiment tests

**Input.** L2401 corrects the requested dependency, and L2432–2439 distinguish direct consecutive distance from the vector region being compared. The previous response had tested a different mapping.

**Procedure.** Name the source object, target object, reference frame, metric, and time alignment; compare each with the code. Preserve the user-selected method and reframe the next experiment only after the mapping is understood. Keep the old result under its old question. It is not confirmation or refutation of the newly clarified relation.

**Supported output.** A precise corrected experimental contract, with the previous result limited to the relation it actually tested. No unrelated implementation or tool replacement follows from that clarification.
