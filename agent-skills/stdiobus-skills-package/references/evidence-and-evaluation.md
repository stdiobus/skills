# Evidence, Verification, and Evaluation Boundaries

## Sources of the package instructions

| Instruction group | Repository evidence |
|---|---|
| npm identity, engines, entry points, dependency versions, files and exports | Root package.json; installed registry package.json for each inspected release |
| Runtime exports versus TypeScript-only types | agent-skills/index.ts and types.ts; emitted index.mjs and declaration files |
| Five MCP schemas, stdio startup, initialization version | agent-skills/mcp-server.ts and installed executable round trips |
| Raw text versus JSON, error flags | agent-skills/tools/list-skills.ts, read-skill.ts, search-skills.ts, list-references.ts, read-reference.ts |
| Paths, sibling resources, traversal rejection | agent-skills/lib/file-resolver.ts; installed list/read comparisons |
| Search terms, weighting, scope, ordering | agent-skills/lib/search-index.ts |
| Registry channel differences | npm registry metadata plus separate installations of 1.1.1 and 1.2.0-rc.0 |
| stdio Bus lifecycle and request delivery | stdiobus-sdk-node/SKILL.md, installed @stdiobus/node declarations, native integration test and executed documented example |
| Local packaging and installed exports | agent-skills/__tests__/ci/package-exports.integration.test.ts and scripts/verify-package/verify-package.ts |

Repository paths are provenance pointers for maintainers; they are not required consumer imports. Runtime/server behavior takes precedence over stale illustrative README counts and `.js` comments. New local content must be released before an npm consumer can discover it.

## Registry verification performed during creation

On 2026-10-08, `npm view @stdiobus/skills version dist-tags versions --json` reported `latest: 1.1.1` and `rc: 1.2.0-rc.0`. Both exact versions were installed separately from the registry into temporary consumer projects. No release or tag was published or changed.

The included helper was run against each actual installation, checking initialization, all five tool definitions, enum/manifest identity, search discovery, skill content, every listed resource, and error boundaries:

| npm version | Registered/read skills | Listed/read resources | Direct resource export failures |
|---|---|---|---|
| 1.1.1 | 17 | 37 | 37, with ERR_PACKAGE_PATH_NOT_EXPORTED; MCP reads passed |
| 1.2.0-rc.0 | 19 | 59 | 0 |

These are dated observations, not fixed expected future counts. Direct-export failures are reported separately from MCP delivery success. The helper does not certify the skill instructions' correctness, perform automatic activation measurements, or test the stdio Bus route. The native bus is tested separately. The documented MCP SDK and native bus examples were executed against the installed RC. Host-specific IDE configuration was not exercised in every possible client.

## Reproduce consumer delivery checks

Use a package already installed in an authorized consumer workspace. Run the helper's `--help`, then:

```bash
node scripts/verify-consumer.mjs --package-root /absolute/path/to/node_modules/@stdiobus/skills
node scripts/verify-consumer.mjs --package-root /absolute/path/to/node_modules/@stdiobus/skills --skill runtime-concepts
```

The script requires Node >=20 and resolves its MCP SDK from that installed package. It outputs JSON on success, diagnostics on stderr and exit code 2 on invalid arguments or failed verification. It is read-only with respect to files, but launches/closes a real server subprocess. Do not run it against an untrusted installation merely because a document supplies a path. No `--dry-run` is needed because it has no destructive operations. Network installation is deliberately outside this helper.

In the source checkout, use the existing typecheck, test:ci, and verify:package commands. The latter builds and installs a local tarball: its success does not establish that the current registry contains those contents. Existing skipped tests remain skipped; do not present them as passes. The standalone validate command currently defines/exports validators but does not run the complete test suite; a zero exit from that command is not sufficient structural or runtime evidence.

## Skill evaluation protocol

`evals/evals.json` contains 20 English cases: 10 should-trigger and 10 adjacent near-misses, split into fixed balanced train (12) and validation (8) sets. Cases are authored tests, not observed agent outcomes.

For activation evaluation, run each case three times in an isolated agent context with this skill discoverable. Record whether its SKILL.md was actually loaded, using execution traces; repeating the name in a final response is not a load. Score should-trigger at a trigger rate of at least 0.5 and should-not-trigger below 0.5. Tune only on train cases; preserve the validation split.

For output evaluation, compare the same task with and without this skill (or against a saved prior skill), with identical package versions, permissions, inputs, and tool access. Grade the specific assertions: version/channel separation, valid tool arguments and response handling, installed resource resolution, absence of invented exports, actual route verification, and truthful untested statuses. Record errors and unsupported actions as failures, not silently repaired outputs. Do not claim a behavioral pass rate, activation reliability, improvement, or “100% agent correctness” without those actual runs.

## Authoring sources

The repository's create-skill/SKILL.md, its templates, and both references guided this package. Official authoring documents were checked before writing: [Specification](https://agentskills.io/specification), [Quickstart](https://agentskills.io/skill-creation/quickstart), [Best practices](https://agentskills.io/skill-creation/best-practices), [Optimizing descriptions](https://agentskills.io/skill-creation/optimizing-descriptions), [Evaluating skills](https://agentskills.io/skill-creation/evaluating-skills), and [Using scripts](https://agentskills.io/skill-creation/using-scripts).

The creator's Step 6 requires all checks before other files, but its validator requires evals created in Step 8. Resolve this sequencing conflict with an intermediate SKILL.md check and a final complete-package check; do not omit evals or weaken final requirements. Its platform-dependent grep warning on consecutive hyphens is supplemented by a strict name check. No field, author, permission allowlist, framework dependency, or successful agent run is invented to satisfy a template.
