import { StdioBus } from '@stdiobus/node';
import * as path from 'path';
import * as fs from 'fs';
import { SkillName } from '../../../types';

const root = path.resolve(__dirname, '../../../..');

it('delivers both workflow skills and every supporting resource through native stdio Bus', async () => {
  const bus = new StdioBus({
    backend: 'native',
    config: { pools: [{ id: 'skills', command: process.execPath, args: [path.join(root, 'out/dist/mcp-server.mjs')], instances: 1 }] },
  });
  try {
    await bus.start();
    await bus.request('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'workflow-skills-test', version: '1.0.0' },
    });
    async function call(name: string, args: Record<string, string> = {}): Promise<string> {
      const result: any = await bus.request('tools/call', { name, arguments: args });
      expect(result.isError).toBeUndefined();
      return result.content[0].text;
    }
    const manifest = JSON.parse(await call('list_skills'));
    expect(manifest.skills.map((s: any) => s.name).sort()).toEqual(Object.values(SkillName).sort());
    for (const skill of ['create-skill', 'evidence-driven-rd']) {
      expect(JSON.parse(await call('search_skills', { query: skill })).map((s: any) => s.skill)).toContain(skill);
      expect(await call('read_skill', { skill })).toBe(fs.readFileSync(path.join(root, 'agent-skills', skill, 'SKILL.md'), 'utf8'));
      const resources: string[] = JSON.parse(await call('list_references', { skill }));
      expect(resources.some((ref) => ref.startsWith('assets/'))).toBe(true);
      expect(resources.some((ref) => ref.startsWith('scripts/'))).toBe(true);
      for (const reference of resources) {
        const prefixed = /^(assets|scripts|evals|agents)\//.test(reference);
        const diskPath = path.join(root, 'agent-skills', skill, ...(prefixed ? [] : ['references']), reference);
        expect(await call('read_reference', { skill, reference })).toBe(fs.readFileSync(diskPath, 'utf8'));
      }
    }
  } finally {
    await bus.stop();
    bus.destroy();
  }
}, 20_000);
