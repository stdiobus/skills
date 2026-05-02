// =============================================================================
// Canonical Template: EventBridge Fanout
// Skill: runtime-patterns-async
// Use Case: Produce events to EventBridge and consume them with pattern matching
// Framework: @worktif/runtime >=0.5.0 <1.0.0
// =============================================================================

import { LambdaDefinition } from '@worktif/runtime';
import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import type { EventBridgeEvent } from 'aws-lambda';

// =============================================================================
// PRODUCER: Lambda that emits events to EventBridge
// =============================================================================

// Step 1: Define producer service
class OrderEventProducer {
  private client = new EventBridgeClient({});

  async emitOrderCreated(order: { orderId: string; customerId: string; total: number }): Promise<void> {
    await this.client.send(new PutEventsCommand({
      Entries: [{
        Source: 'myapp.orders',
        DetailType: 'OrderCreated',
        Detail: JSON.stringify(order),
        EventBusName: 'my-custom-bus',
      }],
    }));
  }
}

type ProducerTies = { orderEventProducer: OrderEventProducer };

// Producer Lambda — creates an order and emits an event
export const createOrderHandler: LambdaDefinition<ProducerTies> = {
  id: 'create-order',
  ties: { orderEventProducer: OrderEventProducer },
  handler: async (event, context) => {
    const orderData = JSON.parse(event.body ?? '{}');

    // Business logic: create the order
    const order = { orderId: 'ord-123', customerId: orderData.customerId, total: orderData.total };

    // Emit event to EventBridge for downstream consumers
    await event.ties.orderEventProducer.emitOrderCreated(order);

    return { statusCode: 201, body: JSON.stringify(order) };
  },
  http: { method: 'POST', path: '/orders' },
};

// =============================================================================
// CONSUMER: Lambda triggered by EventBridge rule matching the event pattern
// =============================================================================

// Step 2: Define consumer service
class NotificationService {
  async sendOrderConfirmation(orderId: string, customerId: string): Promise<void> {
    // Implementation: send email, push notification, etc.
  }
}

type ConsumerTies = { notificationService: NotificationService };

// Consumer Lambda — triggered when OrderCreated events match the pattern
export const orderCreatedConsumer: LambdaDefinition<ConsumerTies, {}, 'eventbridge'> = {
  id: 'order-created-notification',
  ties: { notificationService: NotificationService },
  handler: async (event, context) => {
    // event is typed as EventBridgeEvent<string, unknown> (augmented with ties)
    const detail = event.detail as { orderId: string; customerId: string; total: number };

    await event.ties.notificationService.sendOrderConfirmation(
      detail.orderId,
      detail.customerId,
    );

    // EventBridge consumers do not return a meaningful value
  },
  eventbridge: {
    eventBus: 'my-custom-bus',          // Event bus name, ARN, or CDK IEventBus
    eventPattern: {
      source: ['myapp.orders'],          // Match events from this source
      detailType: ['OrderCreated'],      // Match this detail type
    },
    description: 'Send notification when a new order is created',
  },
};
