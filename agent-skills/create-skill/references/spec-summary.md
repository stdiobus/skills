# Agent Skills Spec — Compact Reference

Source of truth: https://agentskills.io/specification
Local copy (if present): `skill-creation/` inside the project's skills directory.

## Directory structure

```
<skills-root>/
└── <skill-name>/               ← directory name MUST match `name` frontmatter exactly
    ├── SKILL.md                ← required
    ├── references/             ← optional; load on demand
    ├── assets/                 ← optional; templates, data, images
    ├── scripts/                ← optional; executable scripts
    └── evals/
        └── evals.json          ← strongly recommended
```

Default `<skills-root>` locations (check which one this project uses):
- `.agents/skills/` — default (VS Code Copilot, Claude Code, Codex)
- `steering/` — project-level alternative

## Frontmatter fields — complete table

| Field | Required | Constraints |
|-------|----------|-------------|
| `name` | Yes | 1–64 chars. `[a-z0-9-]` only. No leading, trailing, or consecutive hyphens. Must match parent directory name. |
| `description` | Yes | 1–1024 chars. Non-empty. Must describe both what the skill does and when to use it. |
| `license` | No | Short string: `MIT`, `Apache-2.0`, or name of a bundled license file. |
| `compatibility` | No | 1–500 chars. Environment requirements: Node version, required packages, network, intended product. |
| `metadata` | No | `Record<string, string>` — arbitrary key-value pairs. |
| `allowed-tools` | No | **Space-separated** (not comma-separated) string of pre-approved tool names. Experimental. |

## SKILL.md body limits

- Under **500 lines** and **5000 tokens**
- Move long tables, detailed reference, and scenario-specific content to `references/`
- Every `references/` file must have an explicit conditional trigger in the body

## Progressive disclosure — 3 tiers

| Tier | Content | Loaded |
|------|---------|--------|
| Metadata | `name` + `description` only | At agent startup for every skill |
| Instructions | Full `SKILL.md` body | When agent decides skill is relevant |
| Resources | Files in `references/`, `assets/`, `scripts/` | Only when body explicitly instructs |

## Conditional reference trigger — required pattern

```markdown
Read `references/error-tables.md` if the error category is unclear or you need the
per-provider mapping.
```

**Wrong (unconditional):** `See references/ for more details.`

## evals/evals.json structure

```json
{
  "skill_name": "<must match SKILL.md name field>",
  "evals": [
    {
      "id": 1,
      "prompt": "realistic user message",
      "expected_output": "human-readable description of success",
      "should_trigger": true,
      "assertions": [
        "specific verifiable statement about the output"
      ]
    }
  ]
}
```

`should_trigger` defaults to `true` if omitted.
Minimum: **3 should-trigger + 2 should-not-trigger** (near-miss cases).

## scripts/ design rules (from using-scripts.mdx)

- No interactive prompts — agents run in non-interactive shells
- Include `--help` output (primary way agent learns the interface)
- Send data to stdout, diagnostics to stderr
- Structured output (JSON/CSV) preferred over free-form text
- Idempotent where possible — agents may retry
- Support `--dry-run` for destructive operations
- Pin dependency versions for reproducibility
