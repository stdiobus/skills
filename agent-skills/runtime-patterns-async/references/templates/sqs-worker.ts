// =============================================================================
// Canonical Template: SQS Worker
// Skill: runtime-patterns-async
// Use Case: Process messages from an SQS queue with batch handling and partial
//           failure reporting
// Framework: @worktif/runtime >=0.5.0 <1.0.0
// =============================================================================

import { LambdaDefinition } from '@worktif/runtime';
import type { SQSEvent, SQSBatchResponse } from 'aws-lambda';

// Step 1: Define service classes
class OrderService {
  async processOrder(orderId: string, payload: Record<string, unknown>): Promise<void> {
    // Implementation: validate order, update database, trigger fulfillment
  }

  async isAlreadyProcessed(orderId: string): Promise<boolean> {
    // Implementation: check idempotency store (DynamoDB, Redis, etc.)
    return false;
  }

  async markAsProcessed(orderId: string): Promise<void> {
    // Implementation: write to idempotency store
  }
}

// Step 2: Define ties type
type OrderWorkerTies = {
  orderService: OrderService;
};

// Step 3: Create Lambda definition with SQS integration
export const orderWorkerHandler: LambdaDefinition<OrderWorkerTies, {}, 'sqs'> = {
  id: 'process-orders',
  ties: {
    orderService: OrderService,  // Class constructor, NOT instance
  },
  handler: async (event, context) => {
    // event is typed as SQSEvent (augmented with ties and snapshot)
    const batchItemFailures: { itemIdentifier: string }[] = [];

    for (const record of event.Records) {
      try {
        const payload = JSON.parse(record.body);
        const orderId = payload.orderId;

        // Idempotency check — SQS standard queues provide at-least-once delivery
        if (await event.ties.orderService.isAlreadyProcessed(orderId)) {
          continue;
        }

        await event.ties.orderService.processOrder(orderId, payload);
        await event.ties.orderService.markAsProcessed(orderId);
      } catch (error) {
        // Report this message as failed — it will be retried individually
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }

    // Return partial failure report — only failed messages are retried
    return { batchItemFailures } as SQSBatchResponse;
  },
  sqs: {
    queue: 'orders-queue',              // Queue name or CDK IQueue construct
    batchSize: 10,                      // 1–10000 records per invocation
    maxBatchingWindowSeconds: 30,       // Wait up to 30s to fill batch (0–300)
    reportBatchItemFailures: true,      // Enable partial failure reporting
  },
};
