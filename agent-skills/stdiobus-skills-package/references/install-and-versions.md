# Installation, Identity, and Launch Configuration

## Establish identity before choosing a command

Run from the consumer project using its dependency manager. For an npm consumer:

```bash
node --version
npm --version
npm view @stdiobus/skills dist-tags --json
npm ls @stdiobus/skills --depth=0
```

The installed package requires Node >=20 and npm >=10. The repository uses Yarn 1.22.22 for development; a consumer does not need Yarn, TypeScript, esbuild, or this source checkout merely to run the published package. Honor an existing consumer lockfile rather than introducing another manager.

For a new npm consumer that explicitly selects a version:

```bash
npm install --save-exact @stdiobus/skills@1.1.1
```

`1.1.1` is an example of the checked stable version, not a permanent default. For explicitly requested prerelease capabilities, the checked RC can be selected with `@stdiobus/skills@1.2.0-rc.0`. A mutable tag such as `@rc` is useful for discovery but not an immutable reproduction identifier. Inspect tags again before recommending a current release.

## Published release observations

Verified by installing both versions from the npm registry on 2026-10-08:

| Property | 1.1.1 | 1.2.0-rc.0 |
|---|---|---|
| Registry tag at inspection | latest | rc |
| Manifest skill count | 17 | 19 |
| create-skill / evidence-driven-rd | Absent | Present |
| MCP sibling resources assets/scripts/evals/agents | Not provided by this release's resolver | Provided with prefixes |
| Direct nested resource exports | Two-wildcard reference pattern; observed resolution failure | Single-wildcard fallback; observed resolution success |
| Manifest/MCP server version | 1.0.0 | 1.0.0 |

A new skill added to the checkout is not automatically in either immutable release. Check `list_skills` on the running installation. Never replace a missing released feature with a local source path while claiming to use the published package.

## MCP host configuration

Example for a host that accepts the existing `mcpServers` configuration format:

```json
{
  "mcpServers": {
    "@stdiobus/skills": {
      "command": "npx",
      "args": ["-y", "@stdiobus/skills@1.2.0-rc.0"]
    }
  }
}
```

Use the version actually selected for that task. The configuration schema belongs to the host; do not claim this example was tested in every IDE. Host installation/configuration changes require the task's authorization. If an existing host already exposes these tools, use that connection.

Alternative: after installing the dependency, resolve its `mcp-server` export and launch Node with that absolute path. The package bin is `mcp-skills`, targeting `out/dist/mcp-server.mjs`. Do not use the stale `.js` path found in some source comments. For offline use, prefer the installed executable; an uncached npx launch needs registry access.

## Identity fields

- `package.json.version`: npm release identity.
- `skills-manifest.json.version`: manifest/server version used in MCP server info.
- `frameworkVersion`: framework metadata; not Node or package version.
- `skills[].versionRange`: compatibility of that skill's subject. Runtime skills use framework ranges; stdio Bus SDK skills use their SDK ranges; general workflow skills use `*`.

Inspect the entry's `status`; the documented workflow consumes `valid` entries. A status or timestamp does not independently establish execution quality or freshness. Resolve conflicts between the entry's range, actual installed target dependency, and skill body before applying instructions.
