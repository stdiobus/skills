/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FileResolver } from '../lib/file-resolver.js';

/** MCP tool result shape. */
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/**
 * Handle the `list_skills` tool call.
 * Returns the full skills manifest as a JSON string in MCP tool result format.
 */
export async function handleListSkills(resolver: FileResolver): Promise<ToolResult> {
  try {
    const manifest = await resolver.readManifest();
    return {
      content: [{ type: 'text', text: JSON.stringify(manifest, null, 2) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `list_skills: ${message}` }],
      isError: true,
    };
  }
}
