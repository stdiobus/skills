/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import type { SkillManifest } from '../types.js';

/**
 * Resolves and reads skill files relative to the package root.
 * All paths are resolved from the package installation directory,
 * not the consumer's working directory.
 */
export interface FileResolver {
  /** Absolute path to the package root directory. */
  readonly packageRoot: string;

  /**
   * Absolute path to a skill's references root directory
   * (`{packageRoot}/agent-skills/{skillName}/references`).
   *
   * This is the SINGLE place that encodes the on-disk references layout. Both
   * {@link listReferences} and {@link readReference} resolve against it, and the bundled
   * {@link SkillProvider} exposes it through its resource-scope contract so the runtime can
   * enforce containment against the *actual* references root rather than the coarse package
   * root. Pure path computation — performs no I/O and does not check existence.
   */
  referencesRoot(skillName: string): string;

  /** Read and parse the skills-manifest.json file. */
  readManifest(): Promise<SkillManifest>;

  /** Read the full SKILL.md content for a given skill name. */
  readSkill(skillName: string): Promise<string>;

  /**
   * List reference files for a skill.
   * Excludes `.gitkeep` files. Preserves relative paths for nested
   * subdirectories (e.g., `templates/sqs-worker.ts`).
   */
  listReferences(skillName: string): Promise<string[]>;

  /**
   * Read a specific reference file for a skill.
   * Rejects paths containing `..` to prevent directory traversal.
   */
  readReference(skillName: string, referencePath: string): Promise<string>;
}

/**
 * Recursively list all files under a directory, returning paths
 * relative to the given base directory.
 */
async function listFilesRecursive(dir: string, base: string): Promise<string[]> {
  const results: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listFilesRecursive(fullPath, base);
      results.push(...nested);
    } else {
      results.push(path.relative(base, fullPath));
    }
  }

  return results;
}

/**
 * Create a FileResolver instance.
 *
 * @param packageRootOverride - Optional override for the package root path.
 *   When omitted, the root is resolved from `__dirname` assuming the bundled
 *   `out/dist/mcp-server.js` location: `path.resolve(__dirname, '..', '..')`.
 */
export function createFileResolver(packageRootOverride?: string): FileResolver {
  const packageRoot = packageRootOverride ?? path.resolve(__dirname, '..', '..');

  return {
    get packageRoot() {
      return packageRoot;
    },

    referencesRoot(skillName: string): string {
      return path.join(packageRoot, 'agent-skills', skillName, 'references');
    },

    async readManifest(): Promise<SkillManifest> {
      // @toto: include merging by custom manifest
      const manifestPath = path.join(packageRoot, 'agent-skills', 'skills-manifest.json');
      const content = await fs.readFile(manifestPath, 'utf-8');
      return JSON.parse(content) as SkillManifest;
    },

    async readSkill(skillName: string): Promise<string> {
      const skillPath = path.join(packageRoot, 'agent-skills', skillName, 'SKILL.md');
      try {
        return await fs.readFile(skillPath, 'utf-8');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          throw new Error(
            `SKILL.md not found for skill: ${skillName}. Expected at: ${skillPath}`,
          );
        }
        throw err;
      }
    },

    async listReferences(skillName: string): Promise<string[]> {
      const refsDir = this.referencesRoot(skillName);
      const files = await listFilesRecursive(refsDir, refsDir);
      return files
        .filter((f) => path.basename(f) !== '.gitkeep')
        .sort();
    },

    async readReference(skillName: string, referencePath: string): Promise<string> {
      // Reject directory traversal attempts
      if (referencePath.includes('..')) {
        throw new Error(
          'Invalid reference path — directory traversal ("..") is not allowed.',
        );
      }

      const refsDir = this.referencesRoot(skillName);
      const resolvedPath = path.resolve(refsDir, referencePath);

      // Belt-and-suspenders: verify the resolved path stays within references/
      if (!resolvedPath.startsWith(refsDir + path.sep) && resolvedPath !== refsDir) {
        throw new Error(
          'Invalid reference path — resolved path is outside the references directory.',
        );
      }

      try {
        return await fs.readFile(resolvedPath, 'utf-8');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          throw new Error(
            `File not found — "${referencePath}" does not exist in ${skillName}/references/.`,
          );
        }
        throw err;
      }
    },
  };
}
