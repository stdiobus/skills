---
name: create-skill
description: >
  Use this skill whenever creating a new Agent Skill or improving an existing one in any
  project. Activate when asked to write a SKILL.md, design a new skill, convert a flat
  documentation file into a proper skill, audit an existing skill for spec compliance,
  improve a skill description so it triggers more reliably, add evals, add references/,
  or add a validation loop to a skill. Also activate when the user says "create a skill
  for X", "make a skill that does Y", "this doc needs to be a skill", "turn this into a
  skill", or "fix this skill" — even without mentioning SKILL.md or the agentskills.io
  spec explicitly. Do NOT activate for writing regular documentation, README files, or
  code — only for Agent Skills in SKILL.md format.
license: MIT
---

# Create Skill

## Step 1 — Locate the spec before writing anything

The agentskills.io specification lives in one of these places — check in order:

1. A local `skill-creation/` directory inside the project's skills directory (e.g. `steering/skill-creation/` or `.agents/skills/skill-creation/`)
2. Online at https://agentskills.io/specification and https://agentskills.io/skill-creation/best-practices

**Always read the spec first.** Do not write from memory — spec details change.

The required files to read:
- `quickstart.mdx` — directory structure and SKILL.md format
- `best-practices.mdx` — content principles, gotchas patterns, progressive disclosure
- `optimizing-descriptions.mdx` — description field rules and optimization loop
- `evaluating-skills.mdx` — evals structure and grading
- `using-scripts.mdx` — scripts/ design for agentic use (only if the skill needs scripts)

## Step 2 — Determine the skill directory

Skills live in a directory whose name matches the `name` frontmatter field exactly. The standard locations are:

- `.agents/skills/<name>/SKILL.md` — default location (VS Code Copilot, Claude Code, Codex)
- `steering/<name>/SKILL.md` — project-level alternative (used in this repo)

If the project already has a skills directory with other skills, place the new skill alongside them. Do not mix locations.

## Step 3 — Understand the domain

Read all source material before writing:
- Existing flat `.md` files being converted
- Relevant source code when the skill covers a library or API
- Real examples, usage patterns, error outputs
- Any existing skills in adjacent domains (to calibrate scope and avoid overlap)

**Every fact in the skill body must come from source material — not from general knowledge.**

## Step 4 — Validate coherent scope

Ask: "Is there exactly one task class this skill encapsulates?"
- Can name two distinct task classes → split into two skills
- Skill only adds value when loaded with another skill always → reconsider the split
- Scope too broad to activate precisely → narrow the description, split content

## Step 5 — Write SKILL.md

Use the template in `assets/SKILL.md.template`. Mandatory sections in every SKILL.md:

| Section | Purpose |
|---------|---------|
| YAML frontmatter | `name`, `description`, optional `compatibility`/`license`/`allowed-tools` |
| Step-by-step procedure | How to approach the task class — actionable, not declarative |
| `## Gotchas` | Project-specific facts that defy reasonable assumptions |
| `## Validation` | Self-check steps at each stage before moving forward |
| Conditional reference trigger | `"Read references/X.md if [specific condition]"` |

Keep SKILL.md under 500 lines. Move detail to `references/`.

## Step 6 — Validate frontmatter

Run the validation script:

```bash
bash .agents/skills/create-skill/scripts/validate-frontmatter.sh <path-to-SKILL.md>
```

All checks must pass before proceeding to the next step.

## Step 7 — Write references/ for detail material

Move to `references/` when content meets any of these criteria:
- Table longer than 10 rows
- Worked example longer than 20 lines
- Content needed only in a specific sub-scenario, not every run

In SKILL.md body write an explicit conditional trigger for every reference file:
```
Read `references/error-tables.md` if the error category is unclear or you need the per-provider mapping.
```
Never write a generic "see references/ for details" — that loads context unconditionally.

## Step 8 — Write evals/evals.json

Minimum 6 test cases: ≥ 3 should-trigger, ≥ 2 should-not-trigger.

The most valuable should-not-trigger cases are **near-misses** — queries that share keywords with this skill but actually need a different skill. "Write a fibonacci function" is too easy (no keyword overlap). "How do I set temperature?" as a negative for `failure-handling` is a near-miss — that is the right pattern.

Use `assets/evals.template.json`.

## Step 9 — Optimize the description

Apply these rules to the `description` field:
1. **Imperative phrasing** — "Use this skill when..." not "This skill does..."
2. **Implicit triggers** — include phrases the user says without naming the domain ("even if they don't say 'session' explicitly")
3. **Near-miss exclusions** — "Do NOT activate for X" when adjacent skills share keywords
4. **Concrete keywords** — name the actual API methods, error messages, or tools the skill covers
5. **Character limit** — under 1024 characters: `echo -n "description" | wc -c`

## Frontmatter compliance checklist

- [ ] `name` — lowercase `[a-z0-9-]`, 1–64 chars, no leading/trailing/consecutive hyphens
- [ ] `name` — **exactly matches the parent directory name**
- [ ] `description` — present, under 1024 chars, imperative phrasing, implicit triggers covered
- [ ] `compatibility` — present if skill has environment or tool requirements
- [ ] `license` — present (use the project's license)
- [ ] SKILL.md — under 500 lines
- [ ] `references/` files — each has an explicit conditional trigger in SKILL.md body
- [ ] `evals/evals.json` — ≥ 3 should-trigger + ≥ 2 near-miss should-not-trigger
- [ ] `## Gotchas` — project-specific facts, not generic advice
- [ ] `## Validation` — present with actionable self-check steps

## Gotchas

- **`name` must match the directory name exactly — character for character.** `name: my-skill` inside `my-skill/SKILL.md` is correct. `name: mySkill`, `name: my_skill`, or `name: My-Skill` are validation failures even if the content is otherwise perfect.
- **Generic gotchas add noise, not value.** "Handle errors appropriately" tells the agent nothing it doesn't already know. A gotcha must name a specific fact the agent would get wrong: "Closed sessions are deleted, not transitioned to a 'closed' state — `sessions_status` returns 'not found' on a closed session."
- **`references/` that load unconditionally defeat progressive disclosure.** The entire point of `references/` is on-demand loading. "See `references/` for more" negates this. Every reference file must have a trigger: "Read `references/X.md` if Y."
- **Descriptions grow during optimization and silently exceed 1024 chars.** Count after every revision.
- **`allowed-tools` is space-separated, not comma-separated.** `tool-a tool-b` is valid; `tool-a, tool-b` is not.
- **The spec is the source of truth — not memory.** Always read the spec files before creating or auditing a skill. The authoritative spec is in `skill-creation/` inside the project's skills directory, or at https://agentskills.io/specification.

## Validation

After writing SKILL.md: run `validate-frontmatter.sh` and confirm all 16 checks pass before writing any other files.
After writing references/: grep for `Read \`references/` in SKILL.md and confirm every reference file under `references/` is named by at least one conditional trigger.
After writing evals: confirm ≥ 2 should-not-trigger cases are near-misses (share keywords with this skill but route to a different skill).
Before finishing: verify `description` character count is under 1024.

Read `references/spec-summary.md` if you need a compact reference of all frontmatter fields,
their exact constraints, optional directories, and the progressive disclosure model without
reading the full skill-creation docs.

Read `references/description-optimization.md` if the description needs improvement or systematic
testing: imperative phrasing rules, eval query design, train/validation split, and the
optimization loop procedure.
