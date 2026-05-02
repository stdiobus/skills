/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SearchIndex } from '../lib/search-index.js';

/** MCP tool result shape. */
type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/**
 * Handle the `search_skills` tool call.
 * Validates the query is non-empty, runs the search, and returns
 * a JSON array of SearchResult objects sorted by score descending.
 */
export async function handleSearchSkills(
  args: { query: string },
  searchIndex: SearchIndex,
): Promise<ToolResult> {
  if (!args.query || args.query.trim().length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: 'search_skills: Query must be a non-empty string.',
        },
      ],
      isError: true,
    };
  }

  const results = searchIndex.search(args.query);
  return {
    content: [{ type: 'text', text: JSON.stringify(results) }],
  };
}
