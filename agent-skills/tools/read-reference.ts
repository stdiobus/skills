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
 * Handle the `read_reference` tool call.
 * Validates the skill name and reference path, checks for directory
 * traversal, then returns the raw file content as text.
 */
export async function handleReadReference(
  args: { skill: string; reference: string },
  resolver: FileResolver,
): Promise<ToolResult> {
  if (!VALID_SKILL_NAMES.has(args.skill)) {
    const validNames = Object.values(SkillName).join(', ');
    return {
      content: [
        {
          type: 'text',
          text: `read_reference: Invalid skill name "${args.skill}". Valid skill names: ${validNames}`,
        },
      ],
      isError: true,
    };
  }

  if (args.reference.includes('..')) {
    return {
      content: [
        {
          type: 'text',
          text: 'read_reference: Invalid reference path — directory traversal ("..") is not allowed.',
        },
      ],
      isError: true,
    };
  }

  try {
    const content = await resolver.readReference(args.skill, args.reference);
    return {
      content: [{ type: 'text', text: content }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `read_reference: ${message}` }],
      isError: true,
    };
  }
}
