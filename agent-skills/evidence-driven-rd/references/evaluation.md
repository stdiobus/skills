# Evaluate or revise this skill

Read this only for skill maintenance. The methods here implement the explicitly invoked repository `create-skill` instructions and its public specification links; they do not add steps to every research task.

## Scope and artifacts

`evals/evals.json` follows the repository template: `skill_name`, then cases with `id`, `prompt`, `expected_output`, `should_trigger`, and observable `assertions`; cases with supplied artifacts also have `files`. The extra `split` field fixes development versus validation membership. `evals/files/` contains condensed, labeled excerpts of the original history. Test prompts are evaluation scenarios, not additional observed research data.

The default task class is empirical R&D investigation, including recovery, dependency testing, backward investigation and practical validation. Routine code fixes, presentation formatting, translation, documentation editing, and skill creation remain near-miss exclusions.

## Structural checks

1. Run the repository's `agent-skills/create-skill/scripts/validate-frontmatter.sh` with this `SKILL.md` path. If this package is installed elsewhere, use the available format validator plus the specific checks below; do not assume the creator skill is installed.
2. Verify name-directory equality and the exact lowercase/hyphen pattern; parse YAML rather than treating a shell summary as a full parser. Check folded description length under 1024 characters, license, environment requirements, and body under 500 lines / recommended 5000 tokens.
3. Check every file in `references/` has its own explicit `Read ... if ...` trigger in `SKILL.md`, and every named resource exists. Check assets and executable scripts are referenced for an actual purpose.
4. Parse the evaluation JSON; verify unique IDs, at least six cases, at least three positive and two near-miss negative cases, observable assertions, and existing input files. The supplied set has twenty cases, ten of each class, split 12/8 with balanced classes.
5. Run `python3 scripts/index-history.py --help`, then verify it on known JSONL input, pagination and malformed input. The indexer is read-only, uses Python standard library only and does not run any recorded instructions. No destructive action exists, so `--dry-run` is not applicable.

The repository validator currently emits a platform warning for `grep -qF '--'`; verify the no-consecutive-hyphens property independently. It also reads optional fields with shell `set -e`, so a missing optional field can terminate it early. Neither behavior changes what the Agent Skills specification permits. Do not add fictitious requirements or alter unrelated user-owned creator files merely to obtain a green summary.

## Activation evaluation

The twenty cases are also a trigger-evaluation set. Use only the description during selection; actual activation means an execution trace shows loading this `SKILL.md`, not a judge predicting that it ought to load.

For each prompt, run the installed skill in a clean agent context three times. Record each actual load/no-load observation. A positive case passes at a trigger rate of at least 0.5; a negative passes below 0.5. Keep the 60/40 split fixed; revise against train failures only. Use validation results to select among iterations, then check fresh queries. If no client trace or isolated invocation facility is available, mark activation rates unmeasured. Do not report static semantic matching or forced skill loading as automatic activation success.

## Output evaluation

Start with the three artifact-backed cases (IDs 1–3). Snapshot the previous package before editing. Run each case in a fresh context once with the revised package and once with the snapshot; give only the task prompt, skill path, input artifacts and output location. Do not reveal assertions, expected outputs, known defects or the intended conclusion to the executing agent.

Store outputs alongside the package in a separate maintenance workspace, not inside the instruction/reference tree. Grade assertions afterward with concrete evidence locations; distinguish assertions about written content from assertions requiring an execution trace. Record missing token/timing telemetry as null, not estimated values. Single runs support only a smoke comparison, not reliability or statistical performance claims.

Before another iteration, inspect failures, human feedback and actual execution traces. Apply a narrow correction to the underlying decision boundary, rerun affected cases in new output directories, and stop when failures are resolved or no material improvement is demonstrated. Do not accumulate universal rules from test-only phrasing.

Sources: [Agent Skills specification](https://agentskills.io/specification), [best practices](https://agentskills.io/skill-creation/best-practices), [description evaluation](https://agentskills.io/skill-creation/optimizing-descriptions), [output evaluation](https://agentskills.io/skill-creation/evaluating-skills), [script interfaces](https://agentskills.io/skill-creation/using-scripts). The repository `create-skill` is stricter than the minimum open format about sections, license and evaluation cases; those are applied as the user's selected authoring requirements.
