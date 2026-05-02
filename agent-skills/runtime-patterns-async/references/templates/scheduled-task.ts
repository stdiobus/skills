// =============================================================================
// Canonical Template: Scheduled Task
// Skill: runtime-patterns-async
// Use Case: Run periodic tasks on a schedule (cron or rate expression)
// Framework: @worktif/runtime >=0.5.0 <1.0.0
// =============================================================================

import { LambdaDefinition } from '@worktif/runtime';
import type { ScheduledEvent } from 'aws-lambda';

// Step 1: Define service classes
class CleanupService {
  async deleteExpiredSessions(): Promise<{ deletedCount: number }> {
    // Implementation: query and delete expired sessions from database
    return { deletedCount: 42 };
  }

  async archiveOldRecords(olderThanDays: number): Promise<{ archivedCount: number }> {
    // Implementation: move old records to cold storage
    return { archivedCount: 150 };
  }
}

class HealthCheckService {
  async checkDependencies(): Promise<{ healthy: boolean; details: Record<string, boolean> }> {
    // Implementation: ping databases, external APIs, etc.
    return { healthy: true, details: { database: true, cache: true, api: true } };
  }
}

// Step 2: Define ties types
type CleanupTies = { cleanupService: CleanupService };
type HealthCheckTies = { healthCheckService: HealthCheckService };

// Step 3: Create Lambda definitions with schedule integration

// Example 1: Rate expression — run every 5 minutes
export const sessionCleanupHandler: LambdaDefinition<CleanupTies, {}, 'schedule'> = {
  id: 'cleanup-sessions',
  ties: {
    cleanupService: CleanupService,  // Class constructor, NOT instance
  },
  handler: async (event, context) => {
    // event is typed as ScheduledEvent (augmented with ties and snapshot)
    // event.time contains the scheduled invocation time (ISO 8601)

    const result = await event.ties.cleanupService.deleteExpiredSessions();

    // Scheduled tasks do not return a meaningful value to the caller
    // Use logging for observability
    console.log(`Cleaned up ${result.deletedCount} expired sessions at ${event.time}`);
  },
  schedule: {
    schedule: 'rate(5 minutes)',        // Run every 5 minutes
    description: 'Delete expired user sessions',
    enabled: true,
  },
};

// Example 2: Cron expression — run daily at noon UTC
export const archiveHandler: LambdaDefinition<CleanupTies, {}, 'schedule'> = {
  id: 'archive-old-records',
  ties: { cleanupService: CleanupService },
  handler: async (event, context) => {
    const result = await event.ties.cleanupService.archiveOldRecords(90);
    console.log(`Archived ${result.archivedCount} records older than 90 days`);
  },
  schedule: {
    schedule: 'cron(0 12 * * ? *)',     // Noon UTC every day
    description: 'Archive records older than 90 days',
    enabled: true,
  },
};

// Example 3: Cron expression — run every 15 minutes for health checks
export const healthCheckHandler: LambdaDefinition<HealthCheckTies, {}, 'schedule'> = {
  id: 'health-check',
  ties: { healthCheckService: HealthCheckService },
  handler: async (event, context) => {
    const result = await event.ties.healthCheckService.checkDependencies();

    if (!result.healthy) {
      // Log unhealthy dependencies for CloudWatch alerting
      console.error('Health check failed:', JSON.stringify(result.details));
    }
  },
  schedule: {
    schedule: 'cron(0/15 * * * ? *)',   // Every 15 minutes
    description: 'Check health of external dependencies',
    enabled: true,
  },
};
