/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SkillManifest } from '../types.js';

/** Layer number → human-readable layer name. */
const LAYER_NAMES: Record<number, string> = {
  1: 'Concepts',
  2: 'API',
  3: 'Patterns',
  4: 'Guardrails',
  5: 'Diagnostics',
};

/** A single search result with relevance scoring metadata. */
export interface SearchResult {
  skill: string;
  score: number;
  description: string;
  layer: number;
  layerName: string;
}

/** An in-memory search index over skill content. */
export interface SearchIndex {
  /** Search skills by query string. Returns results sorted by score descending. */
  search(query: string): SearchResult[];
}

/**
 * Source field for a term occurrence, used to apply boost multipliers.
 * - name/description: 3x boost
 * - layerName: 2x boost
 * - body: 1x (no boost)
 */
type TermSource = 'name' | 'description' | 'layerName' | 'body';

/** Boost multipliers per source field. */
const SOURCE_BOOST: Record<TermSource, number> = {
  name: 3,
  description: 3,
  layerName: 2,
  body: 1,
};

/** Internal representation of an indexed skill document. */
interface IndexedDocument {
  skill: string;
  description: string;
  layer: number;
  layerName: string;
  /** term → { count per source, source with highest boost } */
  terms: Map<string, { count: number; bestSource: TermSource }>;
}

/**
 * Tokenize and normalize a string into lowercase alphanumeric terms.
 * Splits on non-alphanumeric characters and filters out empty tokens.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * Extract the YAML frontmatter `description` field from a SKILL.md string.
 * Returns an empty string if no frontmatter or description is found.
 */
function extractDescription(skillContent: string): string {
  const fmMatch = skillContent.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return '';

  const frontmatter = fmMatch[1];
  // Match multi-line description (YAML block scalar with >)
  const descMatch = frontmatter.match(/^description:\s*>\s*\n((?:\s{2,}.*\n?)*)/m);
  if (descMatch) {
    return descMatch[1]
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join(' ');
  }

  // Match single-line description
  const singleMatch = frontmatter.match(/^description:\s*(.+)$/m);
  if (singleMatch) {
    return singleMatch[1].trim();
  }

  return '';
}

/**
 * Extract the body text (everything after the YAML frontmatter closing `---`).
 */
function extractBody(skillContent: string): string {
  const fmEnd = skillContent.indexOf('\n---', 3);
  if (fmEnd === -1) return skillContent;
  return skillContent.slice(fmEnd + 4);
}

/**
 * Add tokenized terms from a text source into a document's term map.
 * For each term, tracks the total count and the best (highest-boost) source.
 */
function addTerms(
  termMap: Map<string, { count: number; bestSource: TermSource }>,
  text: string,
  source: TermSource,
): void {
  const tokens = tokenize(text);
  for (const token of tokens) {
    const existing = termMap.get(token);
    if (existing) {
      existing.count += 1;
      // Keep the source with the higher boost
      if (SOURCE_BOOST[source] > SOURCE_BOOST[existing.bestSource]) {
        existing.bestSource = source;
      }
    } else {
      termMap.set(token, { count: 1, bestSource: source });
    }
  }
}

/**
 * Build a search index from the skills manifest and pre-loaded SKILL.md contents.
 *
 * The index uses TF-IDF scoring with boost multipliers:
 * - Skill name and description matches: 3x boost
 * - Layer name matches: 2x boost
 * - Body text matches: 1x (no boost)
 *
 * @param manifest - The parsed skills-manifest.json
 * @param skillContents - Map of skill name → full SKILL.md content
 */
export function buildSearchIndex(
  manifest: SkillManifest,
  skillContents: Map<string, string>,
): SearchIndex {
  const documents: IndexedDocument[] = [];
  const totalDocs = manifest.skills.length;

  // Term → number of documents containing the term (for IDF)
  const documentFrequency = new Map<string, number>();

  // Index each skill
  for (const skill of manifest.skills) {
    const content = skillContents.get(skill.name) ?? '';
    const description = extractDescription(content);
    const body = extractBody(content);
    const layerName = LAYER_NAMES[skill.layer] ?? '';

    const terms = new Map<string, { count: number; bestSource: TermSource }>();

    addTerms(terms, skill.name, 'name');
    addTerms(terms, description, 'description');
    addTerms(terms, layerName, 'layerName');
    addTerms(terms, body, 'body');

    documents.push({
      skill: skill.name,
      description,
      layer: skill.layer,
      layerName,
      terms,
    });

    // Update document frequency for each unique term in this document
    for (const term of terms.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  return {
    search(query: string): SearchResult[] {
      const queryTokens = tokenize(query);
      if (queryTokens.length === 0) return [];

      const results: SearchResult[] = [];

      for (const doc of documents) {
        let score = 0;

        for (const token of queryTokens) {
          const termEntry = doc.terms.get(token);
          if (!termEntry) continue;

          // TF: term frequency in this document (raw count)
          const tf = termEntry.count;

          // IDF: inverse document frequency
          const df = documentFrequency.get(token) ?? 1;
          const idf = Math.log(totalDocs / df) + 1;

          // Apply boost based on the best source field for this term
          const boost = SOURCE_BOOST[termEntry.bestSource];

          score += tf * idf * boost;
        }

        if (score > 0) {
          results.push({
            skill: doc.skill,
            score,
            description: doc.description,
            layer: doc.layer,
            layerName: doc.layerName,
          });
        }
      }

      // Sort by score descending
      results.sort((a, b) => b.score - a.score);

      return results;
    },
  };
}
