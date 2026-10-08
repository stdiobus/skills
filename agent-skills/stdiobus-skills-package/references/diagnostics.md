# Consumer Diagnostics

Check the installed version and the failing boundary before changing code.

| Symptom | Check | Supported next action |
|---|---|---|
| npx launch cannot install | Requested version/tag, registry access, credentials when applicable, npm cache diagnostics | Distinguish registry/network/cache failure from server failure; use an already installed verified version if available |
| mcp-skills not found | Whether the package is installed in this consumer and whether the host resolves local bins | Resolve `@stdiobus/skills/mcp-server` and launch with Node; do not assume a global bin |
| No initialize response | Executable path, stderr, process exit, installed registered SKILL.md files, protocol framing | Fix the identified launch/package defect; do not report an empty successful catalog |
| Handshake version differs from npm version | Compare serverInfo.version with manifest.version and package.json.version | Use package metadata for npm identity; these values intentionally have different roles |
| Skill absent/invalid name | Running connection's `list_skills`, installed package version, schema enum | Use a discovered name or report a release gap; creating a folder beside an installation does not register it |
| Resource not found | `list_references` for the chosen skill, exact returned path, installed release support | Remove an incorrectly added `references/` prefix; use sibling prefixes only when supported; do not fabricate files |
| ERR_PACKAGE_PATH_NOT_EXPORTED | Installed export map and exact subpath | For stable nested references use MCP or the version-specific physical-layout fallback; checked RC has a nested-path fallback |
| require/ESM failure | Main target extension, Node version, consumer module mode | Use ESM/dynamic import; resolve text resources and read them rather than execute them |
| Search gives no useful results | ASCII tokenization, chosen terms, manifest, query scope | Try concrete English terms or enumerate names; references are not in the index |
| Native bus cannot start | SDK native backend/platform prerequisites, worker command, stderr | Diagnose the SDK/environment; report native route as untested if unavailable rather than claiming mock equivalence |

An empty `list_references` is not automatically a defect: some skills have no resource directory. Conversely, `isError: true` is never a successful empty resource. Do not repeatedly retry a deterministic invalid name/path error.

The resolver reads packaged files from the package installation. It does not merge a custom manifest, watch consumer folders, fetch arbitrary URLs, register providers, or expose a write API. A TODO comment is not an implemented capability. A server startup preload failure affects the server before tools become usable.

For a suspected broken release, record npm version, Node version, selected route, executable resolution, exact failing operation, stderr/error result, and the smallest reproducible consumer call. A successful checkout test does not clear a defect in an installed tarball. Do not change package versions, overwrite consumer configuration, publish a release, or change a dist-tag without scope supporting that action.
