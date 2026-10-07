# Description Optimization — Full Procedure

Source: https://agentskills.io/skill-creation/optimizing-descriptions

## What a good description does

The `description` field is the **only** mechanism agents use at startup to decide whether to load
a skill for a given task. Its entire job is triggering accurately — on relevant prompts, and not
on irrelevant ones.

## Four principles

1. **Imperative phrasing** — "Use this skill when..." / "Activate when..." (not "This skill does...")
2. **User intent, not implementation** — describe what the user is trying to achieve, not the skill's mechanics
3. **Pushy scope with implicit triggers** — "even if they don't mention 'CSV' or 'analysis' explicitly"
4. **Near-miss exclusions** — "Do NOT activate for X" when adjacent skills share vocabulary

## Before / After (from spec)

```yaml
# Before — too narrow, no implicit triggers
description: Process CSV files.

# After — imperative, concrete keywords, implicit triggers
description: >
  Analyze CSV and tabular data files — compute summary statistics,
  add derived columns, generate charts, and clean messy data. Use this
  skill when the user has a CSV, TSV, or Excel file and wants to
  explore, transform, or visualize the data, even if they don't
  explicitly mention "CSV" or "analysis."
```

## The optimization loop

### 1. Design 20 eval queries

**10 should-trigger queries** — vary along these axes:
- Phrasing: formal, casual, typos, abbreviations
- Explicitness: some name the domain directly, others describe need without naming it
- Detail: terse ("analyze my sales CSV") alongside context-heavy (file paths, column names, backstory)
- Complexity: single-step tasks and multi-step workflows

**10 should-not-trigger queries — must be near-misses:**
- Share keywords or concepts with this skill
- But actually need a different skill or no skill

**Weak negative** (tests nothing): "Write a fibonacci function" — no overlap.  
**Strong negative**: "Write a Python script that reads a CSV and uploads rows to PostgreSQL" —
involves CSV but the task is database ETL, not analysis. Use this type.

### 2. Split: train (60%) / validation (40%)

- Both sets must have proportional positive/negative mix
- Fix the split across all iterations (no reshuffling)
- Use only train set failures to guide revisions
- Use validation set only to check whether improvements generalize

### 3. Measure trigger rate

Run each query 3 times. Trigger rate = (triggered runs) / 3.
- Should-trigger passes: rate ≥ 0.5
- Should-not-trigger passes: rate < 0.5

### 4. Revise the description

- Should-trigger queries failing → description too narrow → broaden scope or add implicit phrases
- Should-not-trigger queries false-triggering → description too broad → add exclusions
- Do NOT add specific keywords from failed queries — that is overfitting
- Find the general category those queries represent and address that
- If stuck after 3 iterations: try a structurally different framing
- Check character count after every revision: `echo -n "description text" | wc -c`

### 5. Select best iteration

Pick the iteration with the highest **validation** pass rate — not the last one. Later iterations
can overfit to the train set.

## Applying the result

1. Update `description` field in SKILL.md
2. Verify character count under 1024
3. Run 5–10 fresh queries (never seen during optimization) as final sanity check
