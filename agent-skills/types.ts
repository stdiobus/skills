/*
 * @license
 * Copyright 2026-present Raman Marozau, raman@stdiobus.com
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Enum of all skill names, 1:1 with skills-manifest.json entries.
 * Values are kebab-case strings matching the skill directory names.
 */
export enum SkillName {
  // Runtime Web collection (12 skills, 5 layers)
  RuntimeConcepts = 'runtime-concepts',
  RuntimeLifecycle = 'runtime-lifecycle',
  RuntimeApiCore = 'runtime-api-core',
  RuntimeApiIntegrations = 'runtime-api-integrations',
  RuntimePatternsHttp = 'runtime-patterns-http',
  RuntimePatternsAsync = 'runtime-patterns-async',
  RuntimePatternsDataEvents = 'runtime-patterns-data-events',
  RuntimeSsrAndWeb = 'runtime-ssr-and-web',
  RuntimeConstraintsAndGuardrails = 'runtime-constraints-and-guardrails',
  RuntimeErrorsAndDiagnostics = 'runtime-errors-and-diagnostics',
  RuntimeVersioningAndMigration = 'runtime-versioning-and-migration',
  RuntimeValidationAndCi = 'runtime-validation-and-ci',

  // stdio Bus SDK collection (3 skills)
  StdiobusSdkCpp = 'stdiobus-sdk-cpp',
  StdiobusSdkNode = 'stdiobus-sdk-node',
  StdiobusSdkRust = 'stdiobus-sdk-rust',
}

/** A single skill entry from the manifest. */
export interface Skill {
  name: string;
  collection?: string;
  layer: number;
  versionRange: string;
  status: string;
  lastValidated: string;
}

/** The full skills manifest structure. */
export interface SkillManifest {
  version: string;
  frameworkVersion: string;
  skills: Skill[];
  lastValidated: string;
}
