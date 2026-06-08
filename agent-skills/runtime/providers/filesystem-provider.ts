/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

import { createFileResolver, type FileResolver } from '../../lib/file-resolver.js';
import { buildSearchIndex, type SearchIndex } from '../../lib/search-index.js';
import type { SkillManifest } from '../../types.js';
import { formatFqid, parseFqid } from '../fqid.js';
import type {
  ListSkillsInput,
  ReferenceContent,
  ReferenceDescriptor,
  ResolvedSkill,
  SearchResult,
  SearchSkillsInput,
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
 * ─── Native search is OPT-IN ────────────────────────────────────────────────────────
 *
 * By default the provider declares `search: false`, so the runtime orchestrates its
 * documented list+substring fallback (the "providers are not obliged to implement the
 * whole world" property the spike proves). Constructing it with `{ search: true }` flips
 * `capabilities.search` on and backs `search()` with the EXISTING keyword
 * {@link SearchIndex} ({@link buildSearchIndex}) — the same ranking the pre-migration
 * `search_skills` tool used. This is how the MCP adapter routes `search_skills` THROUGH
 * the runtime (`runtime.search()`) while preserving published ranking: the legacy search
 * index is a provider implementation, never an adapter side-channel.
 *
 * The provider owns its `providerLocalRef` (here: the skill directory name). The runtime
 * never interprets it.
 */
export class FilesystemSkillProvider implements SkillProvider {
  readonly id: string;
  readonly capabilities: SkillProviderCapabilities;

  private readonly resolver: FileResolver;
  private manifestCache: SkillManifest | null = null;
  /** Lazily-built keyword index, only when native search is enabled. */
  private searchIndexCache: SearchIndex | null = null;

  constructor(opts: { id?: string; packageRoot?: string; search?: boolean } = {}) {
    this.id = opts.id ?? 'bundled';
    this.resolver = createFileResolver(opts.packageRoot);
    this.capabilities = {
      read: true,
      list: true,
      // OPT-IN: default false keeps the proven runtime fallback path (Property 9). The
      // bundled MCP adapter enables it so `runtime.search()` serves the keyword index.
      search: opts.search === true,
      references: true,
    };
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

  /**
   * Lazily build (and cache) the keyword {@link SearchIndex} over the manifest and the
   * on-disk SKILL.md bodies — the SAME index the pre-migration `search_skills` tool used.
   * Only invoked when native search is enabled; otherwise the runtime fallback applies.
   */
  private async searchIndex(): Promise<SearchIndex> {
    if (!this.searchIndexCache) {
      const manifest = await this.manifest();
      const contents = new Map<string, string>();
      for (const skill of manifest.skills) {
        contents.set(skill.name, await this.resolver.readSkill(skill.name));
      }
      this.searchIndexCache = buildSearchIndex(manifest, contents);
    }
    return this.searchIndexCache;
  }

  /**
   * Native keyword search (enabled only with `{ search: true }`). Runs the existing
   * {@link SearchIndex} and maps each ranked hit onto the runtime {@link SearchResult}
   * shape `{ descriptor, score, description }`, preserving the index's score ordering. The
   * optional `description` carries the matched skill's frontmatter description so a
   * presenter can reproduce the published `search_skills` result shape without re-reading
   * skill content. `input.limit`, when set, caps the number of results (the index already
   * sorts by score descending).
   */
  async search(input: SearchSkillsInput): Promise<SearchResult[]> {
    const index = await this.searchIndex();
    const hits = index.search(input.query);
    const limited = input.limit !== undefined ? hits.slice(0, input.limit) : hits;
    return limited.map((hit) => ({
      descriptor: this.toResolved(hit.skill, hit.layer).descriptor,
      score: hit.score,
      description: hit.description,
    }));
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

  /**
   * Provider resource-scope declaration (Milestone-002 provider resource-scope contract;
   * design §9, Req 11.4).
   *
   * Returns the resolved skill's references root — the SAME directory the underlying
   * {@link FileResolver} resolves reference reads against ({@link FileResolver.referencesRoot}).
   * Reusing the resolver's layout knowledge here (rather than in the runtime) keeps the
   * filesystem layout owned by the provider and makes the runtime's path-traversal guard a
   * TRUE generalization of the resolver's own containment: enforcing
   * {@link checkWithinRoot} against THIS root rejects a cross-skill reference that escapes
   * the skill's references directory, not only a `..` segment. The `reference` argument is
   * unused — the references root is per-skill, the same for every reference under it.
   */
  resourceRoot(resolved: ResolvedSkill, _reference?: string): string {
    const name = resolved.providerLocalRef as string;
    return this.resolver.referencesRoot(name);
  }
}
