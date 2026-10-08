# Programmatic Clients and stdio Bus

Use the consumer's existing connection and lifecycle if present. Examples below are isolated consumer examples, not a new orchestration layer or a requirement to launch a duplicate server.

## MCP SDK client

The package depends on `@modelcontextprotocol/sdk`; a consumer importing the SDK directly should declare its own dependency rather than rely on transitive hoisting. The verification helper instead resolves the SDK from the installed package's dependency context.

```javascript
import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const resolve = createRequire(import.meta.url).resolve;
const client = new Client({ name: 'skills-consumer', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve('@stdiobus/skills/mcp-server')],
});
try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const result = await client.callTool({ name: 'list_skills', arguments: {} });
  if (result.isError) throw new Error(JSON.stringify(result));
  const text = result.content.find((item) => item.type === 'text')?.text;
  if (typeof text !== 'string') throw new Error('Missing manifest text');
  const manifest = JSON.parse(text);
  console.log({ toolNames: tools.map((tool) => tool.name), skillNames: manifest.skills.map((skill) => skill.name) });
} finally {
  await client.close();
}
```

The client SDK initializes the connection; do not manually send a second initialize on the same SDK client. If implementing raw NDJSON instead, send a JSON-RPC request with `initialize` parameters, wait for its result, send `notifications/initialized` without an id, then issue `tools/list` and `tools/call` with unique request ids. Do not confuse raw JSON-RPC envelopes with the unwrapped tool results returned by the SDK.

## Native stdio Bus worker

This example uses the existing `@stdiobus/node` API verified in this repository's native integration test. A consumer importing it directly should declare it as a direct dependency. Native binaries/platform prerequisites belong to that SDK; use the `stdiobus-sdk-node` skill for SDK-specific setup. Do not require a bus for a consumer that only needs the MCP host route.

```javascript
import { createRequire } from 'node:module';
import { StdioBus } from '@stdiobus/node';

const resolve = createRequire(import.meta.url).resolve;
const bus = new StdioBus({
  backend: 'native',
  config: {
    pools: [{
      id: 'skills', command: process.execPath,
      args: [resolve('@stdiobus/skills/mcp-server')], instances: 1,
    }],
  },
});
try {
  await bus.start();
  await bus.request('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'skills-consumer', version: '1.0.0' },
  });
  bus.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
  const result = await bus.request('tools/call', { name: 'list_skills', arguments: {} });
  if (result.isError) throw new Error(JSON.stringify(result));
  const manifest = JSON.parse(result.content[0].text);
  console.log(manifest.skills.map((skill) => skill.name));
} finally {
  await bus.stop();
  bus.destroy();
}
```

The single worker avoids accidentally sending initialization to one process and later calls to another. When integrating with an existing multiworker application, preserve its documented routing/session ownership; do not assume unrelated requests automatically share MCP connection state. The bus wraps JSON-RPC request ids and returns the result; check errors before using content.

Server stdout is exclusively protocol output. Consumer example logging goes to the consumer's stdout, not into the server worker. Stop/destroy belong to the lifecycle owner; a shared application bus must not be destroyed by a temporary helper that does not own it. A client closing its owned transport and a server reading files are separate from executing retrieved instructions.
