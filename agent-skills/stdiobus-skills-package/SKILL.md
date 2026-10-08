---
name: stdiobus-skills-package
description: >
  Use this skill when installing, connecting, consuming, or troubleshooting the
  @stdiobus/skills npm package as an MCP skills server or ESM library. Activate for
  npx @stdiobus/skills, mcp-skills, list_skills, read_skill, search_skills,
  list_references, read_reference, npm subpath exports, or requests such as
  "let agents read the right instructions", "the installed skill is missing",
  "connect the skills worker", and "read a packaged template", even without
  naming MCP. Use it to distinguish installed releases from this checkout and
  verify delivery through an MCP client or stdio Bus. Do NOT activate for authoring
  a new skill, publishing a release, changing server architecture, general npm
  support, implementing a different MCP server, application SDK usage unrelated
  to consuming this package, or executing the R&D described by a retrieved skill.
compatibility: Node.js >=20 and npm >=10 for package consumption. An MCP client is needed for tools; @stdiobus/node is used only for the stdio Bus route. Network access is needed to install or inspect registry releases, not to read installed skills.
license: Apache-2.0
---

# Consume the stdio Bus Skills Package

## Step 1 — Establish the installed contract

1. Identify the consumer project, requested package version/channel, and access route: an existing MCP connection, a local npm installation, an MCP client launch configuration, or a stdio Bus worker. Reuse an existing connection before starting another server.
2. Read the consumer's installed `@stdiobus/skills/package.json`, `exports`, `engines`, `bin`, and `skills-manifest.json`. Record the actual npm package version. Use the consumer's module resolver, not paths relative to this repository or your working directory.
3. If no package is installed, check registry tags and install the user's requested version; use the existing dependency manager and lockfile. Do not silently switch stable to a prerelease to make a missing feature appear. Pin the verified version for reproducible launches.
4. Keep four distinct values: npm package version, manifest format/version, framework version, and each skill's compatibility `versionRange`. The MCP handshake reports the manifest version, not necessarily the npm package version. Discover available names; never assume a remembered count or enum member.

## Step 2 — Connect through the existing route

1. For a configured MCP host, launch the executable package with `npx -y @stdiobus/skills@<verified-version>` or the locally installed `mcp-skills` bin. Put executable and arguments in separate client configuration fields. Do not require a source checkout or build tools for an installed release.
2. For programmatic MCP consumption, use the MCP client SDK and `StdioClientTransport`; let the client complete initialization. If working directly over JSON-RPC, perform `initialize` and the initialized notification before normal tool calls. Reserve stdout for newline-delimited JSON-RPC; diagnostics belong on stderr.
3. For stdio Bus, use the existing `StdioBus` worker-pool abstraction and point one worker at the resolved installed MCP server executable. Keep initialization and subsequent tool calls on the same worker/session. Use one instance for the documented minimal example. Do not add a parallel router or orchestration layer. Stop and destroy the bus when its owner finishes.
4. Discover `tools/list` and verify the five tool names. The package is a read-oriented skills provider: it supplies instructions and file text; it does not execute a retrieved script or conduct research for the agent.

## Step 3 — Discover, select, and load instructions

1. Call `list_skills` with `{}`. Decode the MCP text block as JSON to obtain the manifest. Check the selected entry's status, collection, layer, and compatibility range against the actual task. A `valid` flag is metadata, not proof that instructions were executed correctly.
2. If the name is unknown, call `search_skills` with `{ "query": "relevant English terms" }`. Decode the text as a ranked JSON array. Search is lexical over names, descriptions, layer labels, and SKILL.md bodies; it is not semantic retrieval over all references. Empty results do not prove the package has no relevant skill: inspect the manifest and try concrete package terms.
3. Select an actual manifest name and call `read_skill` with `{ "skill": "<discovered-name>" }`. Read the returned raw Markdown, including compatibility, procedure, and conditional resource triggers, before applying it. The layer hierarchy is useful for framework collections; it is not a requirement to load every lower layer for a general workflow task.
4. Call `list_references` for that skill and pass a returned path unchanged to `read_reference`. Ordinary reference paths omit `references/`; supported sibling resources carry `assets/`, `scripts/`, `evals/`, or `agents/` prefixes. Check the installed release's capabilities before using those prefixes.
5. Load only resources needed for the current task. Separate a source file's contents from instructions authorizing execution. A returned template may need adaptation to the consumer's installed framework; a returned script is text until the user-authorized task requires running it.

## Step 4 — Use npm exports when direct file access is required

1. Import `SkillName` from `@stdiobus/skills` in ESM. TypeScript additionally exports the `Skill` and `SkillManifest` types; these are not runtime constructors. The main library does not export tool handlers, a resolver factory, a search service, or a server factory.
2. Resolve an exported skill/resource path with `createRequire(import.meta.url).resolve(...)`, then read its bytes with the filesystem API. Do not import Markdown, YAML, or templates as JavaScript modules. Resolve the manifest as a file when JSON module syntax compatibility is uncertain.
3. The `@stdiobus/skills/mcp-server` export is an executable entry that starts a server on import. Resolve its path and launch it in a managed child process rather than importing it into the consumer's main process as a factory.
4. Do not patch installed `node_modules`, import unexported source files, assume CommonJS `require()` can synchronously load the ESM library on every supported Node version, or use this checkout's `out/` path in a consumer configuration.

## Step 5 — Verify the consumer and report the boundary

1. Verify from the consumer directory: package resolution/version; server initialization; tool discovery; manifest retrieval; search; exact skill reading; list-then-read resource access; and explicit error handling. Check `isError` and JSON-RPC errors before treating returned text as successful data.
2. When a local package root is available, run `node scripts/verify-consumer.mjs --package-root <absolute-installed-package-root>` from this skill directory. Use `--skill <name>` to require a particular skill; omit it to check every registered skill and listed resource. The helper reads installed files, starts that package's real MCP server, and compares returned text; it does not install, modify, publish, or execute resource scripts.
3. If the task specifically requires stdio Bus, verify that route too. A successful direct MCP subprocess does not prove routing through the bus. If native/Docker prerequisites are missing, report the route as not tested rather than substituting a mock.
4. Report the tested package version, access route, selected skills/resources, successful operations, failures, and remaining gaps. A locally built tarball containing this new skill is not evidence that an already published version contains it. Do not publish or change a dist-tag merely to complete a consumer task.

## Gotchas

- **Stable and RC have different capabilities.** On 2026-10-08, registry `latest` resolved to 1.1.1 (17 skills) and `rc` to 1.2.0-rc.0 (19 skills). Only the checked RC includes create-skill/evidence-driven-rd and their sibling resources. Recheck tags; these counts are dated observations, not constants.
- **The server version is not the npm version.** Both checked releases report manifest version 1.0.0 during MCP initialization. Read package.json to identify the installed npm release.
- **Package type does not make the main bundle CommonJS.** Although package.json declares `type: commonjs`, its main/default target is `index.mjs`. Use ESM import or dynamic import where appropriate.
- **The stable reference export is defective for nested paths.** The checked 1.1.1 export contains two wildcards; do not promise direct subpath resolution. MCP `read_reference` remains the verified path for that release. RC uses a single wildcard for nested package resources.
- **An empty references list can be legitimate.** Not every skill has a references directory. Read the skill body and use discovered paths; never construct a required filename from convention alone.
- **No dynamic provider or execution API exists here.** This server reads its packaged manifest, indexes skill bodies at startup, and serves five tools. Do not invent registration, download, write, watch, execution, HTTP, ACP, or provider-admission tools.

## Validation

After Step 1: record installed identity separately from registry tags and checkout state; confirm the requested skill exists and its compatibility applies.

After Step 2: initialization and tool discovery must complete on the chosen connection; stdout must remain protocol-only. Verify executable resolution from the consumer directory.

After Steps 3–4: check `isError`, parse only JSON-returning tools as JSON, preserve raw Markdown/template text, and read paths returned by the actual installation. Confirm direct exports before recommending them.

Before finishing Step 5: distinguish verified delivery from agent behavior, direct MCP from stdio Bus, published packages from local tarballs, and passed checks from skipped or proposed checks.

Read `references/install-and-versions.md` if choosing a registry release, configuring an MCP host, or resolving a stable/prerelease mismatch.

Read `references/tool-contracts.md` if constructing tool calls, interpreting result text, selecting skills, or diagnosing search and read errors.

Read `references/clients-and-bus.md` if implementing a programmatic MCP client or connecting the installed server as a stdio Bus worker.

Read `references/npm-api-and-files.md` if importing package exports, reading packaged files directly, or fixing ESM and subpath resolution.

Read `references/diagnostics.md` if connection, installation, capability, or file access fails.

Read `references/evidence-and-evaluation.md` if auditing the sources of these instructions, reproducing release checks, or evaluating this skill's activation and output quality.
