// =============================================================================
// Canonical Template: Kinesis Stream Processor
// Skill: runtime-patterns-async
// Use Case: Process records from a Kinesis Data Stream for real-time analytics
// Framework: @worktif/runtime >=0.5.0 <1.0.0
// =============================================================================

import { LambdaDefinition } from '@worktif/runtime';
import type { KinesisStreamEvent } from 'aws-lambda';

// Step 1: Define service classes
class AnalyticsService {
  async recordEvent(eventType: string, payload: Record<string, unknown>, timestamp: number): Promise<void> {
    // Implementation: write to analytics store, aggregate metrics, etc.
  }

  async flushBatch(events: { eventType: string; payload: Record<string, unknown>; timestamp: number }[]): Promise<void> {
    // Implementation: batch write to analytics store for efficiency
  }
}

// Step 2: Define ties type
type AnalyticsTies = {
  analyticsService: AnalyticsService;
};

// Step 3: Create Lambda definition with Kinesis integration
export const clickStreamProcessor: LambdaDefinition<AnalyticsTies, {}, 'kinesis'> = {
  id: 'process-click-stream',
  ties: {
    analyticsService: AnalyticsService,  // Class constructor, NOT instance
  },
  handler: async (event, context) => {
    // event is typed as KinesisStreamEvent (augmented with ties and snapshot)
    // Kinesis delivers records in batches

    const events: { eventType: string; payload: Record<string, unknown>; timestamp: number }[] = [];

    for (const record of event.Records) {
      // Kinesis record data is base64-encoded
      const payload = JSON.parse(
        Buffer.from(record.kinesis.data, 'base64').toString('utf-8'),
      );

      events.push({
        eventType: payload.eventType,
        payload: payload.data,
        timestamp: record.kinesis.approximateArrivalTimestamp,
      });
    }

    // Batch process for efficiency
    await event.ties.analyticsService.flushBatch(events);
  },
  kinesis: {
    stream: 'click-stream',             // Stream name, ARN, or CDK IStream construct
    startingPosition: 'LATEST',         // 'TRIM_HORIZON' (all) or 'LATEST' (new only)
    batchSize: 500,                     // Records per invocation (up to 10000)
    maxBatchingWindowSeconds: 60,       // Wait up to 60s to fill batch
  },
};
