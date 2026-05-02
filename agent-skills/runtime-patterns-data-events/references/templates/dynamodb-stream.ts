// =============================================================================
// Canonical Template: DynamoDB Stream Processor
// Skill: runtime-patterns-data-events
// Use Case: React to DynamoDB table changes with NewImage/OldImage access
// Framework: @worktif/runtime >=0.5.0 <1.0.0
// =============================================================================

import { LambdaDefinition } from '@worktif/runtime';
import type { DynamoDBStreamEvent, AttributeValue } from 'aws-lambda';

// Step 1: Define service classes
class SyncService {
  async syncToSearchIndex(item: Record<string, AttributeValue>): Promise<void> {
    // Implementation: unmarshal DynamoDB item and index in Elasticsearch/OpenSearch
  }

  async removeFromSearchIndex(keys: Record<string, AttributeValue>): Promise<void> {
    // Implementation: remove document from search index
  }

  async recordAuditLog(
    eventName: string,
    keys: Record<string, AttributeValue>,
    oldImage: Record<string, AttributeValue> | undefined,
    newImage: Record<string, AttributeValue> | undefined,
  ): Promise<void> {
    // Implementation: write audit log entry
  }
}

// Step 2: Define ties type
type StreamProcessorTies = {
  syncService: SyncService;
};

// Step 3: Create Lambda definition with DynamoDB Streams integration
export const userTableStreamHandler: LambdaDefinition<StreamProcessorTies, {}, 'dynamodb'> = {
  id: 'sync-user-changes',
  ties: {
    syncService: SyncService,  // Class constructor, NOT instance
  },
  handler: async (event, context) => {
    // event is typed as DynamoDBStreamEvent (augmented with ties and snapshot)
    // DynamoDB Streams delivers records in batches
    const failures: { itemIdentifier: string }[] = [];

    for (const record of event.Records) {
      try {
        const eventName = record.eventName;  // 'INSERT' | 'MODIFY' | 'REMOVE'
        const keys = record.dynamodb?.Keys;
        const newImage = record.dynamodb?.NewImage;
        const oldImage = record.dynamodb?.OldImage;

        // Record audit log for all changes
        await event.ties.syncService.recordAuditLog(
          eventName ?? 'UNKNOWN',
          keys ?? {},
          oldImage,
          newImage,
        );

        // Sync to search index based on event type
        switch (eventName) {
          case 'INSERT':
            // NewImage is present for INSERT
            if (newImage) {
              await event.ties.syncService.syncToSearchIndex(newImage);
            }
            break;

          case 'MODIFY':
            // Both NewImage and OldImage are present for MODIFY
            if (newImage) {
              await event.ties.syncService.syncToSearchIndex(newImage);
            }
            break;

          case 'REMOVE':
            // Only OldImage is present for REMOVE (NewImage is undefined)
            if (keys) {
              await event.ties.syncService.removeFromSearchIndex(keys);
            }
            break;
        }
      } catch (error) {
        // Report this record as failed for partial retry
        if (record.dynamodb?.SequenceNumber) {
          failures.push({ itemIdentifier: record.dynamodb.SequenceNumber });
        }
      }
    }

    // Return partial failure report (requires reportBatchItemFailures: true)
    return { batchItemFailures: failures };
  },
  dynamodb: {
    table: 'users-table',               // Table name, ARN, or CDK ITable construct
    startingPosition: 'LATEST',         // 'TRIM_HORIZON' (all) or 'LATEST' (new only)
    batchSize: 100,                     // Records per invocation
    maxBatchingWindowSeconds: 30,       // Wait up to 30s to fill batch
    reportBatchItemFailures: true,      // Enable partial failure reporting
  },
};
