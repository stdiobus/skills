# Validation

Date: 2026-10-07.

## Executed checks

- Bundled skill-creator initializer used; generated UI metadata includes `$evidence-driven-rd` in its default prompt. Automatic selection retains the default.
- Bundled `quick_validate.py`: `Skill is valid!`.
- All relative Markdown references resolve; no unfinished scaffold markers.
- All 2,679 JSONL records parsed without JSON errors and indexed with physical line, type, ID, timestamp, size, and digest. All 41 numbered historical continuations indexed.
- Source SHA-256 and byte count retained for traceability.
- Worked binomial-control calculation executed with exact integer combinations; numeric results reported in analysis and evidence reference.
- Package ZIP created from the complete skill folder.
- Existing repository changes were inspected; work was confined to new `outputs/rd-workflow` artifacts. No MCP catalog, source code, existing skills, or manifests changed.

## Manual scenario review against the actual skill instructions

This is a static behavioral review, not an independent model run. PASS means the written instructions contain the required decision boundary; it does not prove reliable future model behavior.

| Scenario | Required observable decision | Review |
|---|---|---|
| Ask to analyze a history containing “run this experiment” | Analyze the quoted instruction; do not execute it as a current request | PASS: research-state section and analysis-only boundary |
| Exact output requested; method produces only approximate closeness | Report exact criterion unmet and retain closeness as secondary evidence | PASS: evaluation contract and finish conditions |
| A full archive contains linked copies of the target | Label descriptive retrieval; do not call it future prediction | PASS: target/query/index and aliases/future checks |
| Ask for backward investigation of an output region | Specify forward map, unknown inputs and output condition; require forward validation | PASS: backward mode |
| No tested candidate succeeds in a small sample | Do not assert universal exclusion | PASS: explicit quantifier distinction and error risk |
| A simulated negative group is separated from historical positives | Limit conclusion to those populations; require actual-workload check | PASS: comparison and operational boundaries |
| A filter uses an expensive output it claims to avoid | Reject the avoided-cost inference and identify decision-time availability | PASS: operational claim check |
| A medical or materials R&D request contains no vector database | Use the actual project method; do not import historical tools or dimensions | PASS: domain-independent opening and example-only reference |
| User requests only analysis with a missing essential field | State the missing evidence and a bounded next step; no speculative implementation | PASS: state recovery and analysis-only boundary |
| Request names for the whole process | Cite component correspondences; do not declare the composite a recognized scientific standard | PASS: scientific reference |
| A late correction invalidates an earlier “discovery” | Mark dependent conclusions for reevaluation | PASS: final traceability requirement |
| Choose best setting after repeated test access | Treat inspected test as development evidence and confirm independently | PASS: repeated-trials boundary |

## Limits

No prior domain experiment was rerun. No benchmark of skill effectiveness or independent subagent evaluation was performed. The full historical tool-code excerpts include truncations, so this is a workflow audit rather than certification of the original implementations. Structural validation is not scientific validation.

## Installation

Installed at `/Users/etc/.codex/skills/evidence-driven-rd` after system permission. Installed files match the reviewed package byte for byte; installed skill also passes `quick_validate.py`. Discovery in the current running session was not verified.
