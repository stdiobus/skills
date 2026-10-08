# npm Library and File Access

The public main entry exports only the runtime enum `SkillName` and the TypeScript types `Skill` and `SkillManifest`. `Skill` is not a constructor. The exported server entry is executable; importing it starts the MCP server. Internal `createFileResolver`, handlers, and search builders are not public library exports.

## ESM file access from a consumer

Save this as an `.mjs` file in the consumer project, or run equivalent ESM code. This works for the checked stable and RC releases:

```javascript
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { SkillName } from '@stdiobus/skills';

const resolve = createRequire(import.meta.url).resolve;
const pkg = JSON.parse(await readFile(resolve('@stdiobus/skills/package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(resolve('@stdiobus/skills/skills-manifest'), 'utf8'));
const name = SkillName.RuntimeConcepts;
if (!manifest.skills.some((skill) => skill.name === name && skill.status === 'valid')) {
  throw new Error('Required skill is absent or not valid in this installation');
}
const skillText = await readFile(resolve(`@stdiobus/skills/skills/${name}/SKILL.md`), 'utf8');
console.log({ packageVersion: pkg.version, manifestVersion: manifest.version, name, characters: skillText.length });
```

JSON is read as file text here to avoid assuming the consumer's Node/TypeScript JSON module attribute settings. Markdown, YAML, shell files, Python, and JSON evals are resource bytes; do not import them as executable JavaScript.

## Export map

| Subpath | Meaning |
|---|---|
| `@stdiobus/skills` | `out/dist/index.mjs`, with declaration entry `out/tsc/index.d.ts` |
| `@stdiobus/skills/mcp-server` | `out/dist/mcp-server.mjs`, executable |
| `@stdiobus/skills/skills-manifest` | Packaged manifest JSON |
| `@stdiobus/skills/skills/<name>/SKILL.md` | Skill document |
| `@stdiobus/skills/package.json` | Installed package metadata |
| `@stdiobus/skills/skills/<name>/<resource-path>` | RC single-wildcard resource fallback; check presence in the installed version |

For the checked RC, resolve `@stdiobus/skills/skills/evidence-driven-rd/assets/experiment-record.md` or `@stdiobus/skills/skills/runtime-patterns-http/references/templates/single-get.ts`, then read the returned path.

The checked stable 1.1.1 has a `./skills/*/references/*` export with two wildcards. Actual nested reference resolution fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`; do not copy that pattern into consumer code or promise it works. Stable MCP `read_reference` is the supported verified alternative. For offline direct access to a stable reference, derive the installed package root from the explicitly exported package.json path and read an actual packaged `agent-skills/<name>/references/<listed-path>` file; keep this physical-layout fallback version-specific, within that package root, and distinguish it from a public subpath export.

## Version and packaging limits

- The package declares `type: commonjs` but its library and executable are `.mjs` ESM. Use ESM import or dynamic `import()` from CommonJS; do not infer universal synchronous `require()` support from the package type. Exact behavior depends on the consumer's Node version.
- The checked RC includes SKILL.md, references, assets, per-skill scripts, evals, and agents metadata. Developer validation scripts under top-level `agent-skills/scripts/` are excluded. Jest tests and source TypeScript are not a consumer API.
- Public wildcard availability does not mean every path exists. Discover resources and verify the installed file.
- Installed resolution is rooted at the package installation, not the process working directory. Changing the consumer's cwd is not a fix for a missing file in the tarball.
- Do not patch installed package files or require a consumer to rebuild the repository. If release contents are insufficient, report the exact version/capability gap and select a compatible published release only within the user's request.
