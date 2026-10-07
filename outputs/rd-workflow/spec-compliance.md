# R&D Skill Revision Using the Repository's create-skill

Date: 2026-10-07. Applied `agent-skills/create-skill/SKILL.md`, its templates, both references, eval examples, and validator. Before editing, read the official specification, quickstart, best-practices, optimizing-descriptions, evaluating-skills, and using-scripts. No local copies of these pages were found in the repository.

## Result and Scope of Changes

The package source is now located alongside the existing skills: `agent-skills/evidence-driven-rd/`. The personal installation is updated from this source; `outputs/rd-workflow/evidence-driven-rd/` and the ZIP are exports, not separately maintained versions.

One task class was preserved: empirical R&D investigation, from state reconstruction through dependency verification and practical applicability. Domain artifact names did not become requirements. The complete existing `scientific-methods.md` and `process-evidence.md` were preserved byte for byte. For `agents/openai.yaml`, the active Russian settings of the personal installation were preserved: the previous repository export contained an English localization, and it was aligned with the installed version. The core research logic was preserved; structure, specific checkpoints, and execution/verification resources were added.

## Skill Components and Specification Decisions

| Element | Implementation | Basis and boundary |
|---|---|---|
| Name and directory | `evidence-driven-rd`, exact match; strict format validation | Mandatory rule of the open format and create-skill |
| Description | Imperative description, explicit and implicit triggers, Russian phrases, near-miss exclusions | create-skill, Step 9; 749 characters after YAML parsing, 814 UTF-8 bytes |
| License | `Apache-2.0` based on the repository's LICENSE/package.json | Mandatory rule of the selected create-skill; the field is optional in the open format |
| Compatibility | Access to materials; Python 3.9+ only for the optional indexer | Actual helper dependency; does not make Python mandatory for research |
| Allowed-tools | Not added | No user-defined set of preauthorized tools; permissions are not invented |
| Metadata | No additional arbitrary fields added | No need to invent an author, versions, or client settings |
| Procedure | Five identified steps from the previous content | Applied the procedural template and transition checks; the step count does not become a requirement for future investigations |
| Gotchas | Six specific failures from the supplied history | New obligations derive from facts, not generic advice |
| Validation | Checks after stages and before completion | Separates observation, execution, interpretation, and practical effect |
| References | Four files, each with its own `Read ... if ...` trigger | Long tables and cases are loaded conditionally |
| Assets | `experiment-record.md` | Adaptable template based on already listed requirements; not a mandatory project file format |
| Scripts | `index-history.py` | Repeatable operation for reading large JSONL files; no network actions, mutations, or content interpretation |
| Evals | 20 cases: 10 positive, 10 near-miss negative | create-skill template structure; fixed 60/40 split, balanced by class |
| Eval inputs | Three identified abbreviated historical excerpts | Examples from the original investigation; test requests are not presented as new research facts |
| UI metadata | Preserved `agents/openai.yaml` from the active personal installation | Codex client extension; not a mandatory component of the general Agent Skills format |
| Limits | SKILL.md: 102 lines | Below 500; the main text remains compact, with details in resources |

No additional README, changelog, empty resource directories, third-party dependencies, builders, or alternative execution system were added. The executable helper has `--help`, structured stdout, diagnostics on stderr, bounded output, and exit codes 0/2. There are no destructive operations; `--dry-run` therefore does not apply.

## Verification and Identified Validator Contradictions

1. The create-skill validator was run before changes. The original version did not meet the imperative-description requirement; an early exit also prevented a complete list of missing elements.
2. After changing SKILL.md, it was run again before the resources were complete: the only remaining reported FAIL was the missing evals/evals.json. Step 6's literal requirement for “all checks before any other files” conflicts with checking the existence of evals, which is created in Step 8. Resolution: an intermediate SKILL.md check, then a final check of the complete package. Result requirements were not weakened.
3. On the complete package, the validator reports **All 16 checks passed**. However, `grep -qF '--'` produces an option warning on this platform and is not reliable evidence of the absence of consecutive hyphens. The name was independently checked using a strict expression and YAML parsing.
4. All four conditional triggers, link/resource existence, YAML fields and lengths, unique eval IDs, assertion/file presence, and train/validation balance were checked separately.
5. The system quick_validate.py rejects `compatibility`, although the [official specification](https://agentskills.io/specification) explicitly permits this field. The field containing a real requirement was retained; the validator's erroneous rejection was not presented as a format defect. The system validator was not modified.
6. The helper was actually checked using artificial unit-test inputs: complete counts/digest, physical lines/pagination, Unicode/truncation, duplicates, repeatability, text hidden by default, totals-only, malformed records, invalid arguments, and a missing file. These data are identified as test data, not R&D facts.

Machine-check results and truthful eval statuses are available in `revision-validation.json`.

## What Must Not Be Declared Verified

Twenty activation scenarios and three domain quality scenarios with input files were prepared. **Fresh independent agent runs and 60 observations of automatic activation were not performed.** Therefore, activation reliability, behavioral pass rate, and improvement over the old skill are not claimed. Manual inspection of the package does not replace that measurement. `references/evaluation.md` describes execution, the baseline snapshot, grading, recording an actual SKILL.md load, and limits on conclusions.

The MCP registry, enum, manifests, server source code, and package.json were not changed: the request concerns skill structure and personal installation, not extension of the published MCP API. A directory's presence in agent-skills does not itself mean that the skill is registered in the existing MCP catalog.

## Instructions Used

- Repository `agent-skills/create-skill/SKILL.md`: mandatory components, templates, minimum evals, description, and conditional references.
- [Agent Skills specification](https://agentskills.io/specification): minimum format and permitted fields.
- [Quickstart](https://agentskills.io/skill-creation/quickstart): packaging and activation.
- [Best practices](https://agentskills.io/skill-creation/best-practices): justified detail and resources as needed.
- [Optimizing descriptions](https://agentskills.io/skill-creation/optimizing-descriptions): triggers, near-misses, and observing actual activation.
- [Evaluating skills](https://agentskills.io/skill-creation/evaluating-skills): comparing executions and evidence-based grading.
- [Using scripts](https://agentskills.io/skill-creation/using-scripts): helper interface.
