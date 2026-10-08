#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

async function main() {
  const { values } = parseArgs({
    options: { 'package-root': { type: 'string' }, skill: { type: 'string' }, help: { type: 'boolean' } },
    strict: true, allowPositionals: false,
  });
  if (values.help) {
    process.stdout.write('Usage: node verify-consumer.mjs --package-root <installed-@stdiobus/skills-root> [--skill <manifest-name>]\nChecks actual MCP delivery against installed files. No installation, file mutation, publishing, or resource script execution.\nExit codes: 0 success, 2 invalid arguments or failed verification.\n');
    return;
  }
  assert(values['package-root'], '--package-root is required');
  const root = await realpath(path.resolve(values['package-root']));
  const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, '@stdiobus/skills', 'The supplied root is not @stdiobus/skills');
  const fromPackage = createRequire(path.join(root, 'package.json'));
  const library = await import(pathToFileURL(fromPackage.resolve('@stdiobus/skills')).href);
  const manifest = JSON.parse(await readFile(fromPackage.resolve('@stdiobus/skills/skills-manifest'), 'utf8'));
  assert.deepEqual(Object.values(library.SkillName).sort(), manifest.skills.map((skill) => skill.name).sort());
  const selected = values.skill ? manifest.skills.filter((skill) => skill.name === values.skill) : manifest.skills;
  assert(selected.length > 0, 'Requested skill is absent from the installed manifest');
  const { Client } = await import(pathToFileURL(fromPackage.resolve('@modelcontextprotocol/sdk/client/index.js')).href);
  const { StdioClientTransport } = await import(pathToFileURL(fromPackage.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href);
  const client = new Client({ name: 'skills-consumer-verification', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fromPackage.resolve('@stdiobus/skills/mcp-server')] });
  let resourcesChecked = 0;
  const exportFailures = [];
  try {
    await client.connect(transport, { timeout: 10000 });
    assert.equal(client.getServerVersion().version, manifest.version);
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    assert.deepEqual(tools, ['list_references', 'list_skills', 'read_reference', 'read_skill', 'search_skills']);
    const call = async (name, args) => {
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 10000 });
      assert(!result.isError, `${name}: ${JSON.stringify(result)}`);
      const text = result.content.find((block) => block.type === 'text')?.text;
      assert.equal(typeof text, 'string', `${name} did not return text`);
      return text;
    };
    assert.deepEqual(JSON.parse(await call('list_skills', {})), manifest);
    for (const { name } of selected) {
      const text = await call('read_skill', { skill: name });
      assert.equal(text, await readFile(fromPackage.resolve(`@stdiobus/skills/skills/${name}/SKILL.md`), 'utf8'));
      const search = JSON.parse(await call('search_skills', { query: name }));
      assert(search.some((entry) => entry.skill === name), `${name} is not discoverable by name`);
      const resources = JSON.parse(await call('list_references', { skill: name }));
      for (const reference of resources) {
        assert(!reference.includes('..') && !path.isAbsolute(reference), 'Unsafe listed resource path');
        const prefixed = /^(assets|scripts|evals|agents)\//.test(reference);
        const diskPath = path.join(root, 'agent-skills', name, ...(prefixed ? [] : ['references']), reference);
        assert.equal(await call('read_reference', { skill: name, reference }), await readFile(diskPath, 'utf8'));
        const subpath = `@stdiobus/skills/skills/${name}/${prefixed ? '' : 'references/'}${reference}`;
        try {
          assert.equal(await realpath(fromPackage.resolve(subpath)), await realpath(diskPath));
        } catch (error) {
          if (error.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
          exportFailures.push(subpath);
        }
        resourcesChecked += 1;
      }
    }
    for (const reference of ['../package.json', 'assets/../../package.json', '/etc/passwd']) {
      const result = await client.callTool({ name: 'read_reference', arguments: { skill: selected[0].name, reference } }, undefined, { timeout: 10000 });
      assert.equal(result.isError, true, 'Out-of-scope resource access was not rejected');
    }
    const missing = await client.callTool({ name: 'read_skill', arguments: { skill: '__not_a_registered_skill__' } }, undefined, { timeout: 10000 });
    assert.equal(missing.isError, true, 'Invalid skill name was not rejected');
    process.stdout.write(JSON.stringify({
      delivery: 'passed', route: 'direct MCP stdio', packageVersion: pkg.version,
      manifestVersion: manifest.version, registeredSkills: manifest.skills.length,
      checkedSkills: selected.map((skill) => skill.name), resourcesChecked,
      directResourceExports: exportFailures.length ? 'some paths not exported; use MCP' : 'passed for listed resources',
      exportFailures, agentBehavior: 'not measured', stdioBusRoute: 'not tested by this helper',
    }, null, 2) + '\n');
  } finally {
    await client.close();
  }
}
main().catch((error) => {
  process.stderr.write(`verify-consumer: ${error.message}\n`);
  process.exitCode = 2;
});
