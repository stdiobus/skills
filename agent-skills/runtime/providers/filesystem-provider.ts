/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

import { createFileResolver, type FileResolver } from '../../lib/file-resolver.js';
import type { SkillManifest } from '../../types.js';
import { formatFqid, parseFqid } from '../fqid.js';
import type {
  ListSkillsInput,
  ReferenceContent,
  ReferenceDescriptor,
  ResolvedSkill,
  SkillContent,
  SkillDescriptor,
  SkillProvider,
  SkillProviderCapabilities,
  SkillRef,
} from '../contract.js';

/**
 * Bundled filesystem provider.
 *
 * Wraps the EXISTING {@link FileResolver} and skills manifest — no rewrite of disk I/O.
 * This is the default provider that represents skills shipped inside the package.
 *
 * It deliberately does NOT implement `search` (capabilities.search = false) so the spike
 * can prove that the runtime orchestrates a fallback rather than breaking. This is the
 * "providers are not obliged to implement the whole world" property.
 *
 * The provider owns its `providerLocalRef` (here: the skill directory name). The runtime
 * never interprets it.
 */
export class FilesystemSkillProvider implements SkillProvider {
  readonly id: string;
  readonly capabilities: SkillProviderCapabilities = {
    read: true,
    list: true,
    search: false, // intentional: exercises runtime fallback
    references: true,
  };

  private readonly resolver: FileResolver;
  private manifestCache: SkillManifest | null = null;

  constructor(opts: { id?: string; packageRoot?: string } = {}) {
    this.id = opts.id ?? 'bundled';
    this.resolver = createFileResolver(opts.packageRoot);
  }

  private async manifest(): Promise<SkillManifest> {
    if (!this.manifestCache) {
      this.manifestCache = await this.resolver.readManifest();
    }
    return this.manifestCache;
  }

  private toResolved(name: string, layer?: number): ResolvedSkill {
    const source = `agent-skills/${name}/SKILL.md`;
    const descriptor: SkillDescriptor = {
      fqid: formatFqid({ provider: this.id, name }),
      name,
      provider: this.id,
      source,
      layer,
    };
    return {
      descriptor,
      providerId: this.id,
      providerLocalRef: name, // provider-private
      provenanceSeed: { source },
    };
  }

  async resolve(ref: SkillRef): Promise<ResolvedSkill[]> {
    const manifest = await this.manifest();

    const nameFromRef = ((): string | null => {
      switch (ref.kind) {
        case 'name':
          if (ref.provider && ref.provider !== this.id) return null;
          return ref.name;
        case 'fqid': {
          const parts = parseFqid(ref.fqid);
          return parts && parts.provider === this.id && parts.name ? parts.name : null;
        }
        case 'descriptor':
          return ref.descriptor.provider === this.id ? ref.descriptor.name : null;
      }
    })();

    if (!nameFromRef) return [];

    const entry = manifest.skills.find((s) => s.name === nameFromRef);
    if (!entry) return [];

    return [this.toResolved(entry.name, entry.layer)];
  }

  async read(resolved: ResolvedSkill): Promise<SkillContent> {
    const name = resolved.providerLocalRef as string;
    const body = await this.resolver.readSkill(name);
    return { descriptor: resolved.descriptor, body };
  }

  async list(_input?: ListSkillsInput): Promise<ResolvedSkill[]> {
    const manifest = await this.manifest();
    return manifest.skills.map((s) => this.toResolved(s.name, s.layer));
  }

  async listReferences(resolved: ResolvedSkill): Promise<ReferenceDescriptor[]> {
    const name = resolved.providerLocalRef as string;
    const paths = await this.resolver.listReferences(name);
    return paths.map((path) => ({ path }));
  }

  async readReference(resolved: ResolvedSkill, reference: string): Promise<ReferenceContent> {
    const name = resolved.providerLocalRef as string;
    const body = await this.resolver.readReference(name, reference);
    return { path: reference, body };
  }
}
