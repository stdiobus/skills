---
name: verify-package-maintenance
description: >
  Instructions for AI assistants on how to update verify-package.ts
  when skills, exports, build outputs, or package structure change.
---

# Maintaining verify-package.ts

`agent-skills/scripts/verify-package/verify-package.ts` is a real-world package verification script. It builds a tarball via `npm pack`, installs it in an isolated temp directory, and checks every export, bin entry, skill file, and MCP server startup exactly as a consumer would after `npm install @stdiobus/skills`.

Run it: `yarn verify:package`

When you change the package — add a skill, change an export, rename a build output — you must update this script to match. Below are the exact locations and patterns for each type of change.

---

## Adding or removing a skill

Update the `EXPECTED_SKILLS` array in the Skill Content section:

```typescript
const EXPECTED_SKILLS = [
  'runtime-concepts', 'runtime-lifecycle',
  // ... add or remove skill names here
];
```

Each entry gets two checks automatically: SKILL.md existence with frontmatter, and references/ directory existence.

Update the skill count in two places:

1. Exports section — SkillName enum member count:
```typescript
assert(skills.length === 12, ...);  // ← new count
```

2. Exports section — manifest skill count:
```typescript
assert(data.c === 12, ...);  // ← new count
```

If the new skill is a Layer 3 pattern skill with templates, add it to the pattern skills check:

```typescript
for (const skill of ['runtime-patterns-http', 'runtime-patterns-async', '...new-skill...']) {
```

---

## Adding or changing a package export

Every export in `package.json` `"exports"` needs a corresponding check in the Exports section.

Add a `check(...)` block that runs a real import in the consumer directory:

```typescript
check('import from "@stdiobus/skills/new-export" resolves', () => {
  const result = run(
    `node --input-type=module -e "import x from '@stdiobus/skills/new-export'; console.log(typeof x);"`,
    consumerDir,
  );
  assert(result === 'object', `Unexpected type: ${result}`);
});
```

---

## Renaming or moving build outputs

The Structure section checks these paths inside the installed package:

- `out/dist/index.mjs` — ESM library bundle
- `out/dist/mcp-server.mjs` — MCP server executable
- `out/tsc/index.d.ts` — TypeScript declarations
- `out/tsc/types.d.ts` — TypeScript declarations

If you change `esbuild.config.mjs` output paths or `tsconfig.types.json` outDir, update the `fs.existsSync(...)` paths in the Structure section to match.

---

## Changing the bin entry

The bin section checks:

1. `pkg.bin['mcp-skills']` — update the key if you rename the binary
2. `.bin/mcp-skills` symlink — update the filename to match
3. MCP server startup — checks for MODULE_NOT_FOUND and SyntaxError, no change needed unless the entry point moves

---

## Adding new reference file types

If a skill introduces a new reference file that needs validation (like `error-catalog.json`), add a check in the Skill Content section:

```typescript
check('new-file.yaml is valid', () => {
  const p = path.join(pkgDir, 'agent-skills', 'skill-name', 'references', 'new-file.yaml');
  assert(fs.existsSync(p), 'missing');
  // parse and validate
});
```

---

## Changing the manifest schema

Update the manifest assertions if you change `skills-manifest.json` structure:

```typescript
assert(data.v === '1.0.0', ...);   // manifest version
assert(data.c === 12, ...);        // skill count
```

---

## Adding directories that must NOT be published

Add a check in the Cleanliness section:

```typescript
check('no new-dir/ in published package', () => {
  assert(!fs.existsSync(path.join(pkgDir, 'agent-skills', 'new-dir')), 'found');
});
```

---

## Tarball size

Current limit: 500KB. If the package grows past this, check `npm pack --dry-run` to see what is being included. Adjust the limit or fix the `"files"` field in `package.json`.
