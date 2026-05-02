/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

import { SkillName } from '../types.js';
import type { FileResolver } from '../lib/file-resolver.js';

/** MCP tool result shape. */
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/** Set of valid skill name values for fast lookup. */
const VALID_SKILL_NAMES = new Set<string>(Object.values(SkillName));

/**
 * Handle the `list_references` tool call.
 * Validates the skill name, then returns a JSON array of relative
 * reference file paths (excluding .gitkeep, including nested dirs).
 */
export async function handleListReferences(
  args: { skill: string },
  resolver: FileResolver,
): Promise<ToolResult> {
  if (!VALID_SKILL_NAMES.has(args.skill)) {
    const validNames = Object.values(SkillName).join(', ');
    return {
      content: [
        {
          type: 'text',
          text: `list_references: Invalid skill name "${args.skill}". Valid skill names: ${validNames}`,
        },
      ],
      isError: true,
    };
  }

  try {
    const references = await resolver.listReferences(args.skill);
    return {
      content: [{ type: 'text', text: JSON.stringify(references) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `list_references: ${message}` }],
      isError: true,
    };
  }
}
