# Origin of the reusable rules

This file contains historical examples, not domain requirements. The source is the user-supplied `messages.jsonl`, session `sess_6397f700-3b1a-4c19-8831-dacc30f37fc0`, SHA-256 `99aecc5bd1524b5417c858f8c501d631fd65f58dcfe29cf563beff7e8e65f828`.

Locations below are physical JSONL line numbers, not lines inside embedded file excerpts. A full record inventory and detailed Russian analysis accompany the delivered skill package. The source contains 2,679 records, 190 user messages (138 distinct content strings), 618 assistant messages, 302 calls and 302 results. Repeated prompts are not independent replications. Recorded outputs support what was reported in that session; this review does not independently rerun its experiments or authenticate its underlying dataset.

## User-origin requirements generalized into the skill

| Source lines | Historical evidence | Generalized responsibility |
|---|---|---|
| 15; 101; 169 | Learn schema from a small sample; read prior research before continuing | Recover data contracts and research state before action |
| 89–95; 197; 235–248 | Protect another agent's workspace; reject unsolicited rendering changes; isolate continuation | Preserve authorization, method, ownership, and scope |
| 248; 334–386 | Specify chronological train/test, exact complete match, and comparison methods | Preserve the declared evaluation contract; do not universalize this particular ratio or metric |
| 370–439; 524–532 | Ask what code actually retrieves or predicts and what the corpus contains | Describe the actual operation and trace claims to code |
| 445–484; 1279–1346; 1977 | Require full-corpus vector search in particular experiments; later request both vector and direct checks | Preserve the requested method; verify independently when requested; no universal vector database dependency |
| 739–842; 1088–1132; 1653–1679 | Trace visible peaks to their actual coordinates and source records | Connect observations to records and semantics before explanation |
| 921–984; 1838 | Require an executable relation and probability, not a recitation of plotted numbers | Operationalize a dependency and test its meaning |
| 959; 1405–1429 | Parameter variations and formula verification | Maintain explicit configurations; the Fibonacci sequence is a local choice |
| 1006–1088; 1106; 1368 | Work from observations rather than dismissing the investigation from prior expectations | Keep hypotheses testable while preserving logic and source-based constraints |
| 1457–1486 | Reject large opaque inline runs; separate statistics, optimization with statistics, and optimization alone | Use inspectable experiments and separate descriptive from operational claims |
| 1551; 1610–1623 | Investigate the outside of a region and reverse the mapping toward useful inputs | Distinguish complement investigation from inverse inference |
| 1739; 1791; 1927–1943 | Demand a prediction test on real records and identify the practical process being improved | Enforce decision-time input availability and operational relevance |
| 2023–2101; 2158–2183 | Examine alternatives, all three proposed variants, and ToT branches | Keep evidence-linked branches separate without assuming every task needs a tree |
| 2210–2265; 2281 | Check external real cases; explicitly identify missing unknowns | Forward-validate and expose the missing input-output relation |
| 2354–2439 | Correct the meaning of a relation and require comprehension before the next experiment | Resolve material ambiguity before implementation |
| 2462–2469 | Freeze known context, investigate exclusions, and derive admissible inputs | Make the inverse/exclusion contract explicit, including its quantifiers |
| 2496–2547; 2586; 2603–2672 | Demand real validation, exact acceptance criteria, credible gain and count interpretation | Distinguish observed passage, candidate-space size, and useful performance |

## Failures in the responses are not requirements

| Source lines | What the record supports | Consequence for the skill |
|---|---|---|
| 124–199 | Agent moved from reading history to running and proposing changes; user rejected that scope | Reading history does not authorize arbitrary continuation |
| 307–312; 2195–2199 | Byte-order correction was needed; later “leading zeros” output is inconsistent with the represented position of fixed bits | Validate representations before claiming physical or algorithmic meaning; exact later defect needs a code audit |
| 328 | Declared success was exact matching; response shifted to mean Hamming improvement after zero matches | Keep secondary evidence, but do not redefine primary success |
| 364; 518–547 | Boundary-linked exact result, then complete matches with answers in the full corpus; excluding self still retained future records | Separate retrieval, structural identity, and prediction; self exclusion is not complete leakage control |
| 547; 577 | Nearest-of-many was compared with random single picks and described as a hard structural bound | Use an equivalent selection baseline; observed extrema are not universal bounds |
| 977; 1587 | Same numerical corridor was evaluated on different populations: about 99.8% on late test pairs versus 91.733% on all historical pairs | Name the population, regime, and denominator for every probability |
| 1703; 1777 | A local relation was described as predictive; later holdout classification had precision equal to base rate | Retain negative transfer results; revise dependent practical claims |
| 1911–1921 | Many configurations evaluated and a best one reported on test-sampled cases | Confirm after selection on independent evidence; repeated selection can contaminate the test |
| 2050 | Empty test comparison groups produced invalid values | Report insufficient coverage, not performance for an empty group |
| 2094–2152 | Positives were real historical records, negatives simulated; response promoted separation into a pool prefilter claim | Label the control population and verify the actual deployment input and workload |
| 2129 | Mean 8.70× but median 0.84× in a retrospective strategy estimate | Inspect comparable resource budgets and useful outcomes before claiming acceleration |
| 2388–2457 | Several proposed relations were unsupported in the recorded tests | Preserve those results; do not later relabel a tested absence as confirmation |
| 2490–2491; 2596–2597; 2674 | Passage rates were called a breakthrough, then a bug; both explanations borrowed a selected historical passage rate as an unconditional space fraction | Align null distribution and selection conditioning before interpreting passage |
| 2596 | Full-cost term explicitly simulated from prefilter time; not a measured complete run | Separate measured time, assumed cost, rejected fraction, and useful throughput |
| 2653–2666 | Mean neighbor distance was treated as a radius of a single admissible ball, then retracted | An average similarity does not define a necessary acceptance region or a candidate count |

## Worked example: correction of the final interpretation

Example only: this calculation does not establish the real generator's distribution or solve the domain problem.

The recorded criterion uses 256-bit Hamming distance in `[69,109]`. For a uniformly random independent 256-bit output relative to a fixed reference, the exact combinatorial probability is

`p = sum(comb(256,k), k=69..109) / 2^256 = 0.010284725520810178`.

With independent trials, passing at least once among ten has probability

`1 - (1-p)^10 = 0.09821557805834524`.

Passing at least five among one hundred has probability

`sum(comb(100,j) p^j (1-p)^(100-j), j=5..100) = 0.0038630063664778155`.

These are approximately 9.82% and 0.386%, close to the session's 9.92% and approximately 0.37%. This is a mathematical control calculation performed during the review, not a new measured result. Independence and uniformity are assumptions to check for that control. The agreement makes the recorded rates insufficient evidence for the claimed extra dependency; it does not prove the entire implementation correct or prove all possible dependencies absent.

The final assistant response instead treated 91.73% of historically selected valid pairs as 91.73% of arbitrary output space. That inference is unsupported. Do not preserve either the “breakthrough” claim or its subsequent “there must be a bug” correction as fact. See [scientific-methods.md](scientific-methods.md) for the binomial reference and the boundary between statistical controls and evidence.
