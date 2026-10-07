#!/usr/bin/env bash
# validate-frontmatter.sh — validates SKILL.md frontmatter against agentskills.io spec
#
# Usage:
#   bash .agents/skills/create-skill/scripts/validate-frontmatter.sh <path-to-SKILL.md>
#
# Exit codes:
#   0 — all required checks pass
#   1 — one or more checks failed
#   2 — invalid arguments or file not found
#
# The script auto-detects the skill directory from the SKILL.md path.
# No hardcoded project paths — works in any repository.

set -euo pipefail

SKILL_PATH="${1:?Usage: $0 <path-to-SKILL.md>}"

if [[ ! -f "$SKILL_PATH" ]]; then
  echo "Error: file not found: $SKILL_PATH" >&2
  exit 2
fi

PASS=0
FAIL=0

check() {
  local label="$1"
  local result="$2"   # "pass" or "fail"
  local detail="${3:-}"
  if [[ "$result" == "pass" ]]; then
    printf "  \033[32m✓\033[0m %s\n" "$label"
    PASS=$((PASS + 1))
  else
    printf "  \033[31m✗\033[0m %s%s\n" "$label" "${detail:+ — $detail}"
    FAIL=$((FAIL + 1))
  fi
}

info() {
  printf "  \033[33m~\033[0m %s\n" "$1"
}

# ── Resolve paths ─────────────────────────────────────────────────────────────
SKILL_PATH_ABS=$(cd "$(dirname "$SKILL_PATH")" && pwd)/$(basename "$SKILL_PATH")
SKILL_DIR=$(dirname "$SKILL_PATH_ABS")
DIR_NAME=$(basename "$SKILL_DIR")

echo "Validating: $SKILL_PATH_ABS"
echo ""

# ── Extract YAML frontmatter (between first and second ---) ───────────────────
frontmatter=$(awk 'BEGIN{found=0} /^---$/{found++; if(found==2)exit; next} found==1{print}' "$SKILL_PATH_ABS")

# ── Field extraction helpers ──────────────────────────────────────────────────
get_field() {
  # Single-line field: `key: value`
  echo "$frontmatter" | grep "^$1:" | head -1 | sed "s/^$1:[[:space:]]*//" | tr -d "\"'"
}

get_multiline_field() {
  # Handles both `key: value` and `key: >\n  indented lines`
  local key="$1"
  local inline
  inline=$(echo "$frontmatter" | grep "^$key:" | head -1 | sed "s/^$key:[[:space:]]*//" | tr -d "\"'")
  if [[ -n "$inline" && "$inline" != ">" && "$inline" != "|" ]]; then
    echo "$inline"
    return
  fi
  # Block scalar: collect continuation lines (indented with ≥ 2 spaces)
  echo "$frontmatter" \
    | awk "/^$key:/{found=1; next} found && /^  /{print; next} found && /^[^ ]/{exit}" \
    | sed 's/^[[:space:]]*//' \
    | tr '\n' ' ' \
    | sed 's/[[:space:]]*$//'
}

# ── 1. name — present ─────────────────────────────────────────────────────────
name_val=$(get_field "name")
[[ -n "$name_val" ]] && check "name field present" "pass" || check "name field present" "fail" "missing"

# ── 2. name — matches directory ───────────────────────────────────────────────
[[ "$name_val" == "$DIR_NAME" ]] \
  && check "name matches directory ('$DIR_NAME')" "pass" \
  || check "name matches directory" "fail" "name='$name_val'  directory='$DIR_NAME'"

# ── 3. name — valid characters ────────────────────────────────────────────────
if [[ -n "$name_val" ]]; then
  if echo "$name_val" | grep -qE '^[a-z0-9][a-z0-9-]*[a-z0-9]$' \
  || echo "$name_val" | grep -qE '^[a-z0-9]$'; then
    if echo "$name_val" | grep -qF '--'; then
      check "name format (no consecutive hyphens)" "fail" "found '--' in '$name_val'"
    else
      check "name format ([a-z0-9-], no leading/trailing/consecutive hyphens)" "pass"
    fi
  else
    check "name format ([a-z0-9-], no leading/trailing/consecutive hyphens)" "fail" "invalid: '$name_val'"
  fi
fi

# ── 4. name — length ──────────────────────────────────────────────────────────
name_len=${#name_val}
[[ "$name_len" -ge 1 && "$name_len" -le 64 ]] \
  && check "name length 1–64 chars ($name_len)" "pass" \
  || check "name length 1–64 chars" "fail" "$name_len chars"

# ── 5. description — present ──────────────────────────────────────────────────
desc_val=$(get_multiline_field "description")
[[ -n "$desc_val" ]] && check "description present" "pass" || check "description present" "fail" "missing"

# ── 6. description — length ───────────────────────────────────────────────────
desc_len=${#desc_val}
[[ "$desc_len" -ge 1 && "$desc_len" -le 1024 ]] \
  && check "description length 1–1024 chars ($desc_len)" "pass" \
  || check "description length 1–1024 chars" "fail" "$desc_len chars — trim the description"

# ── 7. description — imperative phrasing ─────────────────────────────────────
if echo "$desc_val" | grep -qiE "Use this skill|Activate when|Use when"; then
  check "description: imperative phrasing present" "pass"
else
  check "description: imperative phrasing present" "fail" "add 'Use this skill when...' or 'Activate when...'"
fi

# ── 8. compatibility — optional, check length if present ─────────────────────
compat_val=$(get_multiline_field "compatibility")
if [[ -n "$compat_val" ]]; then
  compat_len=${#compat_val}
  [[ "$compat_len" -le 500 ]] \
    && check "compatibility length ≤ 500 chars ($compat_len)" "pass" \
    || check "compatibility length ≤ 500 chars" "fail" "$compat_len chars"
else
  info "compatibility: not set (optional — add if skill has environment requirements)"
fi

# ── 9. license — optional, inform if absent ───────────────────────────────────
license_val=$(get_field "license")
[[ -n "$license_val" ]] \
  && check "license field present ('$license_val')" "pass" \
  || info "license: not set (optional — recommended: MIT or project license)"

# ── 10. SKILL.md line count ───────────────────────────────────────────────────
line_count=$(wc -l < "$SKILL_PATH_ABS" | tr -d ' ')
[[ "$line_count" -le 500 ]] \
  && check "SKILL.md line count ≤ 500 ($line_count lines)" "pass" \
  || check "SKILL.md line count ≤ 500" "fail" "$line_count lines — move detail to references/"

# ── 11. ## Gotchas section ────────────────────────────────────────────────────
grep -q "^## Gotchas" "$SKILL_PATH_ABS" \
  && check "## Gotchas section present" "pass" \
  || check "## Gotchas section present" "fail" "add a ## Gotchas section with project-specific facts"

# ── 12. ## Validation section ────────────────────────────────────────────────
grep -q "^## Validation" "$SKILL_PATH_ABS" \
  && check "## Validation section present" "pass" \
  || check "## Validation section present" "fail" "add a ## Validation section with self-check steps"

# ── 13. references/ — conditional triggers ───────────────────────────────────
ref_files=$(find "$SKILL_DIR/references" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
if [[ "$ref_files" -gt 0 ]]; then
  trigger_count=$(grep -c "Read \`references/" "$SKILL_PATH_ABS" 2>/dev/null || echo 0)
  [[ "$trigger_count" -gt 0 ]] \
    && check "references/ conditional triggers ($ref_files files, $trigger_count triggers)" "pass" \
    || check "references/ conditional triggers" "fail" \
       "$ref_files reference file(s) found but no 'Read \`references/...' trigger in SKILL.md"
  # Warn about any reference file without a matching trigger
  while IFS= read -r ref_file; do
    base=$(basename "$ref_file")
    if ! grep -q "references/$base" "$SKILL_PATH_ABS" 2>/dev/null; then
      info "references/$base has no trigger in SKILL.md — add: Read \`references/$base\` if <condition>"
    fi
  done < <(find "$SKILL_DIR/references" -name "*.md" 2>/dev/null)
else
  info "references/: none (OK — add if skill body exceeds 500 lines or has scenario-specific detail)"
fi

# ── 14. evals/evals.json — present ───────────────────────────────────────────
eval_file="$SKILL_DIR/evals/evals.json"
[[ -f "$eval_file" ]] \
  && check "evals/evals.json present" "pass" \
  || check "evals/evals.json present" "fail" "create evals/evals.json (see assets/evals.template.json)"

# ── 15. evals — minimum negative (near-miss) cases ───────────────────────────
if [[ -f "$eval_file" ]]; then
  neg_count=$(grep -c '"should_trigger"[[:space:]]*:[[:space:]]*false' "$eval_file" 2>/dev/null || echo 0)
  [[ "$neg_count" -ge 2 ]] \
    && check "evals: ≥ 2 should_trigger:false cases ($neg_count)" "pass" \
    || check "evals: ≥ 2 should_trigger:false cases" "fail" \
       "found $neg_count — add near-miss queries that share keywords but need a different skill"
fi

# ── 16. evals — minimum positive cases ───────────────────────────────────────
if [[ -f "$eval_file" ]]; then
  # Count entries without should_trigger:false (positive by default or explicit true)
  total_count=$(grep -c '"id"' "$eval_file" 2>/dev/null || echo 0)
  pos_count=$((total_count - neg_count))
  [[ "$pos_count" -ge 3 ]] \
    && check "evals: ≥ 3 should-trigger cases ($pos_count)" "pass" \
    || check "evals: ≥ 3 should-trigger cases" "fail" \
       "found $pos_count — add more realistic should-trigger prompts"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
echo "────────────────────────────────────────────"
if [[ "$FAIL" -eq 0 ]]; then
  printf "\033[32m✓ All %d checks passed\033[0m\n" "$PASS"
  exit 0
else
  printf "\033[31m✗ %d check(s) failed\033[0m, %d passed\n" "$FAIL" "$PASS"
  exit 1
fi
