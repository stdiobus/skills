# MCP Tool Contracts and Selection

Source: `agent-skills/mcp-server.ts`, `tools/*.ts`, `types.ts`, and `lib/search-index.ts`. Check the installed server's `tools/list` because a future release may differ.

| Tool | Arguments | Successful first text block |
|---|---|---|
| list_skills | `{}` | JSON object: SkillManifest |
| read_skill | `{ "skill": "<manifest-name>" }` | Raw SKILL.md Markdown |
| search_skills | `{ "query": "nonempty terms" }` | JSON array: ranked search results |
| list_references | `{ "skill": "<manifest-name>" }` | JSON array of relative paths |
| read_reference | `{ "skill": "<manifest-name>", "reference": "<listed-path>" }` | Raw file text |

Successful handlers return `{ "content": [{ "type": "text", "text": "..." }] }`. Errors may arrive as a JSON-RPC error or as an MCP result with `isError: true`. Inspect this before decoding JSON; error text is not a manifest. Use the SDK's result, not the entire raw JSON-RPC envelope, with `client.callTool`.

## Manifest and search data

`SkillManifest` contains `version`, `frameworkVersion`, `skills`, and `lastValidated`.
Each `Skill` contains `name`, optional `collection`, `layer`, `versionRange`, `status`, and `lastValidated`.
A search result contains `skill`, numeric `score`, `description`, `layer`, and `layerName`.

Layer labels in this implementation: 1 Concepts, 2 API, 3 Patterns, 4 Guardrails, 5 Diagnostics. Use them to choose the appropriate level for the task; do not mistake a collection's layer label for a universal research lifecycle.

The in-memory search index is built at startup from manifest entries and SKILL.md bodies. Tokens are lowercased and split on non-ASCII-alphanumeric characters. Names and descriptions have a 3x boost, layer names 2x, body 1x, with term frequency and inverse document frequency scoring. Results are sorted by descending score; no result means no token match. The index does not read references, perform embeddings, translate a non-English query, validate applicability, or run a skill. Use short English terms from the task or enumerate the manifest when appropriate. Do not promise semantic ranking or a probability from the score.

## Progressive reading example

For the checked RC, after confirming `evidence-driven-rd` in the actual manifest:

```json
{"name":"read_skill","arguments":{"skill":"evidence-driven-rd"}}
```

If the current task calls for the scientific-method reference, list resources and then call:

```json
{"name":"read_reference","arguments":{"skill":"evidence-driven-rd","reference":"scientific-methods.md"}}
```

For its experiment record template, the RC accepts:

```json
{"name":"read_reference","arguments":{"skill":"evidence-driven-rd","reference":"assets/experiment-record.md"}}
```

These are `tools/call` parameter objects, not a complete handshake or a universal requirement to load this skill. Never send `references/scientific-methods.md`: ordinary paths are already relative to `references/`. Use the spelling returned by `list_references`, including nested `templates/...` paths. `.gitkeep` is excluded; an absent references directory can correctly produce an empty list. RC sibling resource paths include `assets/`, `scripts/`, `evals/`, and `agents/`.

## Error boundaries

- Invalid skill name: rejected against the `SkillName` enum at the schema/handler boundary; discover names instead of guessing.
- Empty query: rejected; a whitespace query is also rejected by the search handler.
- Missing resource: error text, not a successful empty file.
- Paths containing `..`: rejected. Absolute paths escaping the selected resource directory are rejected as well. Keep valid paths unchanged rather than attempting traversal.
- Startup: all manifest SKILL.md files are preloaded. A malformed package or missing registered file can prevent initialization of the whole server; diagnose the installed package rather than treating it as an empty catalog.

The five tools do not add/remove skills, download providers, write files, run scripts, expose HTTP, or auto-load instructions into an agent. The agent must explicitly read and apply the relevant content under the current user's task.
