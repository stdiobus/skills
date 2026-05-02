// =============================================================================
// Canonical Template: SNS Pub/Sub
// Skill: runtime-patterns-async
// Use Case: Subscribe to an SNS topic and process notifications with filter policy
// Framework: @worktif/runtime >=0.5.0 <1.0.0
// =============================================================================

import { LambdaDefinition } from '@worktif/runtime';
import type { SNSEvent } from 'aws-lambda';

// Step 1: Define service classes
class AlertService {
  async processAlert(severity: string, message: string, source: string): Promise<void> {
    // Implementation: log alert, notify on-call, create incident ticket
  }
}

// Step 2: Define ties type
type AlertHandlerTies = {
  alertService: AlertService;
};

// Step 3: Create Lambda definition with SNS integration and filter policy
export const criticalAlertHandler: LambdaDefinition<AlertHandlerTies, {}, 'sns'> = {
  id: 'critical-alert-handler',
  ties: {
    alertService: AlertService,  // Class constructor, NOT instance
  },
  handler: async (event, context) => {
    // event is typed as SNSEvent (augmented with ties and snapshot)
    // SNS delivers records in batches (typically 1 record per invocation for Lambda)

    for (const record of event.Records) {
      const snsMessage = record.Sns;
      const message = JSON.parse(snsMessage.Message);
      const attributes = snsMessage.MessageAttributes;

      const severity = attributes?.severity?.Value ?? 'unknown';
      const source = attributes?.source?.Value ?? 'unknown';

      await event.ties.alertService.processAlert(
        severity,
        message.description,
        source,
      );
    }
  },
  sns: {
    topic: 'alerts-topic',              // Topic ARN string or CDK ITopic construct
    filterPolicy: {
      severity: ['critical', 'high'],   // Only receive critical and high severity alerts
    },
    rawMessageDelivery: false,          // Keep SNS envelope (default)
  },
};

// Alternative: Raw message delivery (no SNS envelope)
export const rawMessageHandler: LambdaDefinition<AlertHandlerTies, {}, 'sns'> = {
  id: 'raw-alert-handler',
  ties: { alertService: AlertService },
  handler: async (event, context) => {
    for (const record of event.Records) {
      // With rawMessageDelivery: true, record.Sns.Message is the raw payload
      const payload = JSON.parse(record.Sns.Message);
      await event.ties.alertService.processAlert(
        payload.severity,
        payload.description,
        payload.source,
      );
    }
  },
  sns: {
    topic: 'alerts-topic',
    rawMessageDelivery: true,           // Deliver raw message without SNS envelope
  },
};
