// =============================================================================
// Property Test: Terminology consistency
// Feature: runtime-web-agent-skills, Property 7: Terminology consistency
// Validates: Requirements 15.3
// =============================================================================

import * as fc from 'fast-check';
import { checkTerminology } from '../../scripts/validate-skills';

describe('checkTerminology() — Property 7: Terminology consistency', () => {
  /**
   * Generates content using ONLY canonical terms.
   */
  const canonicalContentArb = fc
    .array(
      fc.oneof(
        fc.constant('The ties pattern provides typed dependency injection.'),
        fc.constant('Use LambdaDefinition to define your Lambda function.'),
        fc.constant('The consumer should configure the integration.'),
        fc.constant('Each integration maps to an event source in AWS.'),
        fc.constant('Ties classes are declared in the ties property.'),
        fc.constant('The framework instantiates ties for the consumer.'),
      ),
      { minLength: 1, maxLength: 10 },
    )
    .map((lines) => lines.join('\n'));

  /**
   * Generates content with non-canonical "dependencies" or "DI" terms.
   */
  const nonCanonicalDIArb = fc
    .oneof(
      fc.constant('The dependencies are injected into the handler.'),
      fc.constant('Use DI to provide services to your Lambda.'),
      fc.constant('Configure dependency injection for your services.'),
    );

  /**
   * Generates content with non-canonical "handler definition" term.
   */
  const nonCanonicalHandlerDefArb = fc.constant(
    'Create a handler definition for your endpoint.',
  );

  /**
   * Generates content with non-canonical "user" or "developer" terms.
   */
  const nonCanonicalUserArb = fc
    .oneof(
      fc.constant('The user should configure the endpoint.'),
      fc.constant('The developer needs to set up ties.'),
      fc.constant('A user can define multiple Lambda functions.'),
      fc.constant('A developer should use object-based ties.'),
    );

  /**
   * Generates content with non-canonical "trigger" or "event source" terms.
   */
  const nonCanonicalTriggerArb = fc
    .oneof(
      fc.constant('Configure the trigger for your Lambda function.'),
      fc.constant('The event source maps to an SQS queue.'),
    );

  it('produces no warnings for content using only canonical terms', () => {
    fc.assert(
      fc.property(canonicalContentArb, (content) => {
        const result = checkTerminology(content);
        expect(result.valid).toBe(true);
        expect(result.warnings).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });

  it('flags "dependencies" or "DI" used as synonym for ties pattern', () => {
    fc.assert(
      fc.property(nonCanonicalDIArb, (content) => {
        const result = checkTerminology(content);
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(
          result.warnings.some((w) => w.includes('ties')),
        ).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('flags "handler definition" instead of "LambdaDefinition"', () => {
    fc.assert(
      fc.property(nonCanonicalHandlerDefArb, (content) => {
        const result = checkTerminology(content);
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(
          result.warnings.some((w) => w.includes('LambdaDefinition')),
        ).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('flags "user" or "developer" instead of "consumer"', () => {
    fc.assert(
      fc.property(nonCanonicalUserArb, (content) => {
        const result = checkTerminology(content);
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(
          result.warnings.some((w) => w.includes('consumer')),
        ).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('flags "trigger" or "event source" instead of "integration"', () => {
    fc.assert(
      fc.property(nonCanonicalTriggerArb, (content) => {
        const result = checkTerminology(content);
        expect(result.warnings.length).toBeGreaterThan(0);
        expect(
          result.warnings.some((w) => w.includes('integration')),
        ).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('does not flag terms inside code blocks or import statements', () => {
    const codeContent = fc.oneof(
      fc.constant('```typescript\nimport { dependencies } from "module";\n```'),
      fc.constant('// The user should configure DI here'),
      fc.constant('import { handler } from "./handler-definition";'),
      fc.constant('export const trigger = createTrigger();'),
    );

    fc.assert(
      fc.property(codeContent, (content) => {
        const result = checkTerminology(content);
        // Code lines should be skipped — no warnings
        expect(result.warnings).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });

  it('returns valid=true even when warnings are present (terminology is non-fatal)', () => {
    const mixedContent = fc.oneof(
      nonCanonicalDIArb,
      nonCanonicalHandlerDefArb,
      nonCanonicalUserArb,
      nonCanonicalTriggerArb,
    );

    fc.assert(
      fc.property(mixedContent, (content) => {
        const result = checkTerminology(content);
        // Terminology issues are warnings, not errors
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      }),
      { numRuns: 100 },
    );
  });
});
