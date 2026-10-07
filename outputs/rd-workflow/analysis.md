# R&D Process Analysis and Basis for a General Skill

## Task and Boundaries

Reconstruct the research method, escalating requirements, and meanings of “working backward” from the attached journal; verify scientific names; create a transferable skill. The research topic, experiment names, data fields, and tools do not form the basis of universal requirements.

Source: `/Users/etc/Downloads/sess_6397f700-3b1a-4c19-8831-dacc30f37fc0/messages.jsonl`. Physical JSONL lines are identified as `L…`. SHA-256: `99aecc5bd1524b5417c858f8c501d631fd65f58dcfe29cf563beff7e8e65f828`. Record timestamps: October 4–6, 2026, UTC.

The entire file was structurally parsed: 2,679 records; 190 user messages, of which 138 have distinct content; 618 assistant messages; 302 tool calls and 302 results. Repeated requests, service events, and context truncation are present. They are not counted as separate experiments. The substantive analysis covers the development of requirements and all 41 numbered continuations in the journal. An index of every record is available in `coverage-index.json`.

The journal is evidence of the course of work. An agent message, a user quoting it, or even a recorded tool result does not replace independent reproduction. The original experimental programs and million records were not rerun. Nested reads already truncated in the original journal cannot be fully recovered from it. Images mentioned only by path were not independently checked here. Instructions within the history are treated as analysis material and are not executed again.

## How the Research Is Actually Conducted

The recurring cycle in your requests is:

**real data → observation → clarification of exactly what is observed → testable dependency → computable formulation → experiment and control → transfer verification → practical application or the next unresolved question.**

This is the reconstructed structure of the requirements. It does not mean that the agent fulfilled them correctly at every step.

| Transition | What you require | Basis in the journal |
|---|---|---|
| Reconstruct the state | Read the history, understand the data structure, know where work stopped; inspect a small sample instead of printing a large array | L15, L101, L169, L235 |
| Identify the observation | Examine specific peaks, clusters, and distributions; establish which real records produce them | L739–842, L1088, L1180, L1222, L1653–1679 |
| Clarify the meaning | What an axis means; what the code searches for; what “neighbor,” “match,” “predicts,” and “rejected” mean | L370–439, L524–532, L1132, L1838, L2432–2439, L2586 |
| Formulate the dependency | What depends on what, under which conditions, and with what probability; express it as a formula or executable algorithm | L553, L921–984, L1692, L1838 |
| Test | Calculate using the available real data, compare with fact and control, show charts | L248, L334–386, L959, L1739, L1977 |
| Test robustness | Examine variants, regimes, different parameters, and subsequent data; do not stop at one attractive chart | L959, L1368–1429, L2023–2101, L2158–2183, L2210–2224 |
| Apply to the objective | Name the process that changes; identify what is still missing to obtain a new result rather than verify an already known one | L640–700, L992, L1471–1486, L1791, L1927–1943, L2265, L2281 |
| Reframe the question | When observation and application are disconnected, investigate output constraints, the outside region, and unknown inputs | L1551, L1610–1623, L2335, L2462–2469 |

The main characteristic is that you do not accept a list of numbers as a completed result. The observation must be connected to a computable relation, with an explanation of how it advances the original task. A negative result is an acceptable test outcome: you explicitly require practical claims to be **confirmed or refuted** (L2517–2533).

## Map of the Entire Sequence

The numbers below provide navigation through the historical example only. They do not become skill stage names or a mandatory set of experiments.

| Journal segment | Content of the historical steps | Meaning for the process |
|---|---|---|
| L2–248; preceding history | Setting the search task, reading the structure and history; the agent's unauthorized transition to execution and a different charting method; your interruptions and isolation requirement | Understand the task and action boundaries first |
| 01–02, L291–386 | Predicting the current and previous values using a history split; zero exact matches and one related boundary match | Success must match the stated objective; a boundary identity needs a separate explanation |
| 03–05, L389–547 | Searching the training portion, then the full database, then excluding the answer itself | Retrieving a known object, investigating database geometry, and predicting an unknown are different operations |
| 06–07, L553–700 | Separate analysis of object components and a probabilistic output region; questions about practical use | Describing outputs does not yet provide a way to obtain the required input |
| 08–10, L708–1008 | Studying peaks, fields, and conditional distributions; requiring formulas and their verification | A visual observation must be connected to records, conditions, and computation |
| 11–16, L1014–1443 | Neighbor profiles, transitions, replacement of an unsuitable method, conditioning on regimes, parameter variations | Test the selected operation itself; do not mix representations and regimes |
| 17–19, L1457–1545 | Statistics, acceleration with statistics, and acceleration without statistics examined separately; direct ranking did not produce the claimed benefit | Separate descriptive and operational verification |
| 20–21, L1551–1709 | Confirming regional coverage, investigating outside records, categorization, maps, and the source of a peak | “Working backward” as investigating the complement and context |
| 22–23, L1711–1791 | Searching for relations within a local group and subsequently testing classification; accuracy matched the baseline proportion | A local pattern does not guarantee transfer |
| 24–26, L1799–1937 | Attempts to recover position within a region, repeated search, a combined algorithm, and setting selection | Clarify the target unknown; separate tuning from final evaluation |
| 27–28, L1943–2009 | Investigating outside cases; checking a relation in two ways | Use discrepancies and independent implementations to test a claim |
| 29–31, L2015–2152 | Three application variants: priority, filter, and strategy; empty groups, artificial control, and an ambiguous acceleration metric | Verify the population, cost, and useful application outcome |
| 32–34, L2158–2203 | Multiple branches following a ToT request: bit positions, output constraints, an additional condition | Branching organizes research but does not prove hypotheses |
| L2210–2329 | Checking several current outside records; explicitly asking which unknowns are missing | Demonstration on new examples does not replace the final test of obtaining an unknown |
| 35–38, L2335–2457 | Analysis of an individual input component; correcting the meaning of the dependency and the distinction between direct distances and vector search | First agree on the mapping being tested |
| 39–41, L2462–2674 | Excluding candidates by an output condition, an attempted preliminary filter, comparing regions, questions about the number of possibilities; the agent's erroneous interpretations | The exclusion criterion, selection conditions, and null model are critical to the conclusion |

## Which Stricter Requirements You Apply

Stricter requirements in the journal arise in response to a specific failure. This is a research quality control mechanism, not an ever-expanding list of prohibitions.

| Failure | Your stricter requirement | Transferable rule |
|---|---|---|
| The agent acts instead of analyzing the history | “I did not assign that task,” “we are doing R&D, not generating code,” a separate workspace | Check the authorized action; reading history does not itself authorize continuing it |
| The agent gives a familiar answer instead of testing the observation | Only the obtained data; repeated reminder to work backward | Do not close a testable question with an answer from memory; do not replace verification with agreement |
| The agent restates the chart | Requiring a dependency, formula, probability, and verification in code | Formulate a testable relation from the observation |
| The operation does not match the request | Questions such as “what exactly are you predicting” and “what is the corpus”; requiring the selected tool | Check inputs, outputs, search space, and the actual algorithm |
| Success turns out to be a known answer or proximity | Explicit exact matching, separate control, further checks | Do not change the success criterion after seeing the result; check information availability |
| Research does not advance the practical objective | “What does this improve and in which process,” three separate checks | Identify the operation that changes and measure the resulting benefit |
| The experiment is large and opaque | Files instead of long inline runs; a clear objective; scaling proportionate to computation | Make the executable step inspectable and resource-bounded |
| The meaning of “corridor” changes | Clarifying what is compared and by which method | Do not carry a term across different objects and metrics |
| A filter appears successful | Questions about rejected/admissible cases, acceptance conditions, whether data and gains are real | Check the event definition, control, and cost, not the rejected percentage alone |

Absolute statements from a specific dispute were not turned into general prohibitions on science. For example, “everything you know is wrong” was transferred as a requirement not to replace observations with an unsupported answer from memory. It does not imply rejecting logic, correct dimensions, or verifiable specifications. New explanations are allowed as explicitly identified hypotheses, consistent with your request for multiple variants (L2158).

## What “Working Backward” Means and When to Do It

The journal contains more than one technique. First determine the direction of the transition.

| Variant | When it arises | What to do | What it does not yet prove |
|---|---|---|---|
| From observation to explanation | A pattern is visible but its source is unclear; L1106, L1368 | Find records, conditions, and competing explanations; identify a discriminating test | That the first suitable explanation is true |
| From the result to unknown inputs | An output region is available, but there is no way to obtain a new object; L1610, L2281, L2335 | Define the forward mapping, known context, and unknowns; investigate admissible inputs | That an output description is invertible or that a recovered input is unique |
| From the outside region to an explanation of the inside | A region is established and exceptions need to be understood; L1551, L1943 | Define membership, compare real inside and outside cases under compatible regimes | That everything outside is invalid or that the difference is causal |
| From exclusion to the admissible set | Input choices need to be narrowed; L2462–2469 | Establish the exclusion rule, quantifier, tested domain, and risk of losing an admissible option | That absence of success in a small sample proves impossibility of success in general |
| Back to the operational direction | A backward constraint has been obtained; L1551, L2517–2547 | Apply it to new real cases and test the original task and cost | That reducing the number of candidates automatically means acceleration |

A general expression for the second and fourth variants:

`y = f(x, c)` is the forward mapping; `c` is the known context; `x` is the unknown; `C(y,c)` is the testable output condition.

Investigate `S(c) = {x : C(f(x,c),c)}`. This is a **formalization of the operation**, not a new domain formula discovered in the journal. If `S` cannot yet be computed, that is the unresolved part of the research. An empirical output region may provide only a probabilistic constraint. Without verification, it cannot be treated as a necessary condition that justifies discarding everything outside it.

Application principles:

1. Preserve the original objective; explicitly name the mapping or complement being investigated.
2. Record known quantities and permitted changes. Do not declare a historical output to be an available input for a future solution.
3. State the strength of the test: “there exists,” “for all,” or “found among the tested cases.” These claims are not interchangeable.
4. Compare compatible populations and selection mechanisms. Artificial control data are allowed as an identified control, not as a replacement for real facts.
5. Return to forward verification: do we obtain the required new result under the original criterion and at a justified cost?

This should not automatically be called “proof by contradiction”: that name requires a deductive contradiction from explicitly accepted premises.

## Scientific Names

Scientific literature supports the components. Their correspondence to your process is the result of this analysis, not a claim made by those authors about your work.

| Component | Verified name and source | Limitation |
|---|---|---|
| Observations, charts, distributions, anomalies | Exploratory Data Analysis, [NIST](https://www.itl.nist.gov/div898/handbook/eda/section1/eda11.htm) | Discovering structure is not confirmation |
| Explaining an observed result | Abduction, [Peirce, Harvard lectures, 1903](https://peirce.sitehost.iu.edu/ep/ep2/headers/ep2headx.htm) | An explanation remains a hypothesis |
| Alternatives and discriminating experiments | Strong Inference, [Platt, 1964](https://worthylab.org/wp-content/uploads/2019/05/platt1964.pdf) | The number of runs alone does not constitute strong inference |
| Separating discovery and confirmation | Exploratory/confirmatory research, [Nosek et al., 2018](https://psychologicalsciences.unimelb.edu.au/__data/assets/pdf_file/0007/2888098/The-preregistration-revolution.pdf) | A local plan should not be declared formal preregistration |
| Recovering parameters from results | Inverse Problem, [Tarantola, 2005](https://epubs.siam.org/doi/10.1137/1.9780898717921.ch1) | A forward relation and unknowns are required; invertibility is not guaranteed |
| Excluding values using explicit relations | Constraint satisfaction / consistency enforcement, [Mackworth, 1977](https://www.cs.ubc.ca/~mack/Publications/AI77.pdf) | A sample-based filter does not become a provably sound exclusion algorithm |
| Protecting evaluation from an available answer and future information | Leakage control, [Kapoor & Narayanan](https://arxiv.org/abs/2207.07048) | A split and self-match exclusion alone are insufficient |
| Repeated tuning and unbiased final evaluation | Model-selection bias, [Cawley & Talbot, 2010](https://www.jmlr.org/papers/v11/cawley10a.html) | The best result on a repeatedly inspected test set requires independent verification |
| Branching following your separate request | Tree of Thoughts, [Yao et al., 2023](https://arxiv.org/abs/2305.10601) | Organizes alternatives but does not prove a scientific discovery |

The checked sources do not establish a single generally accepted term for the **entire** combination. The skill name `evidence-driven-rd` is a descriptive working name, not a claimed scientific standard. Investigation of the outside region also retains a literal description of the operation, without an invented authoritative name.

## Critical Verification of the Process's Validity

The skill cannot be built solely from the word “proved” in the agent's responses: the journal contains mutually contradictory interpretations.

**Example 1: success criterion.** In L248, success means an exact match. In L328, after zero matches, the agent shifts the discussion to average proximity. Proximity may be an additional metric, but it does not fulfill the original task.

**Example 2: retrieval and prediction.** In L518, all exact matches are obtained with the answers themselves present in the full corpus. This confirms retrieval of a known record. In L534, the direct answer is excluded, but future records remain; L577 explicitly reports neighbors from the future. This is permissible for retrospective analysis; future prediction requires a different information-availability contract.

**Example 3: selected history and a random space.** L977 and L1587 show different coverage of the same region in different temporal populations. At the end, the agent uses 91.73% of historically selected pairs as the proportion of all possible outputs (L2597, L2674). That transition is unsupported.

A separate **mathematical control**, not a new domain experiment, was performed to check the latter reasoning. Under the assumption of uniform independent 256-bit output, the distance to a fixed vector follows a binomial distribution. The model formula is provided by [NIST](https://itl.nist.gov/div898/handbook/eda/section3/eda366i.htm).

For the recorded condition `[69,109]`:

`p = Σ(k=69..109) C(256,k) / 2^256 ≈ 1.02847%`.

Then:

- at least one hit out of 10: `1−(1−p)^10 ≈ 9.82156%`;
- at least five hits out of 100: `Σ(j=5..100) C(100,j)p^j(1−p)^(100−j) ≈ 0.38630%`.

The journal records 9.92% and approximately 0.37%. Their proximity to this control means that these proportions alone **are not sufficient evidence of a new dependency**. It also proves neither complete code correctness nor the absence of any dependency. Whether the actual generator satisfies the model assumptions requires a separate check.

Therefore, neither the original “breakthrough” nor the subsequent “therefore a bug” can be accepted as a confirmed outcome. Observed numbers, the control model, and interpretation are three different levels.

**Example 4: improvement.** In L2596, the cost of the full computation is explicitly marked `simulated` and derived from filter timing. It is not measured full performance. The proportion of rejected candidates does not say how many useful solutions are lost. In L2094, negative examples are artificial; this is not sufficient proof of effectiveness on a real operational stream.

**Example 5: a region and its size.** In L2653, the average distance to a neighbor is turned into the radius of a single ball of admissible values. That transformation is not proved in the journal. An admissible input space cannot be counted from an average similarity metric without defining the set itself.

This is not an attempt to solve the domain task again. The examples ensure that the skill reproduces your research requirements and does not institutionalize the agent's errors as norms.

## What Was Included in the Skill

`SKILL.md` contains the general cycle, rules for tightening requirements after specific failures, four backward operations, and a mandatory return to forward verification. `references/scientific-methods.md` contains names and their applicability boundaries. `references/process-evidence.md` connects rules to historical lines and retains domain cases only as examples.

No mandatory FAISS, blockchain, 80/20 split, 256 bits, Fibonacci, specific file names, stage count, or universal need for ToT was introduced. No permanent requirement to approve every step was introduced. The actually authorized scope is preserved; material ambiguity is resolved before implementation.

Some safeguards are explicitly engineering consequences of the identified failures, rather than verbatim historical rules: an equivalent control for nearest-of-many, independent verification after repeated tuning, and revisiting dependent conclusions after a premise is refuted. Their bases are identified in the references. These are minimal validity constraints, not invented research results.

## Implementation Plan and Acceptance Criteria

Completed: reconstruct the structure and provenance of requirements → verify scientific correspondences → separate general rules from examples → create the skill through skill-creator → check structure and behavior using control scenarios → prepare installation in the personal skills directory.

Criteria:

- each rule is connected to a real requirement or a specifically identified defect;
- topic-specific details do not become general obligations;
- hypothesis, observation, conclusion, and practical verification are separated;
- “working backward” has explicit inputs, operation, claim strength, and forward verification;
- each scientific name has a public source and a qualified correspondence;
- unsupported results and contradictions are not concealed;
- the skill is structurally valid; structural verification is not presented as proof of effectiveness.

Risks: one history does not prove that the process is complete for all future R&D; authorship and authenticity of the original domain data were not independently checked here; behavioral verification is a manual scenario review, not a separate run by another model. The skill is intended for further refinement only through real use cases.
