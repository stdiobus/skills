// =============================================================================
// Canonical Template: JWT-Authenticated Endpoint
// Skill: runtime-patterns-http
// Use Case: HTTP endpoint protected by JWT token validation
// Framework: @worktif/runtime >=0.5.0 <1.0.0
// =============================================================================

import { LambdaDefinition } from '@worktif/runtime';

// Step 1: Define service classes
class OrdersService {
  async getOrders(userId: string): Promise<{ id: string; total: number; status: string }[]> {
    // Implementation: query orders for the authenticated user
    return [
      { id: 'order-1', total: 59.99, status: 'shipped' },
      { id: 'order-2', total: 129.00, status: 'pending' },
    ];
  }
}

// Step 2: Define ties type
type GetOrdersTies = {
  ordersService: OrdersService;
};

// Step 3: Create Lambda definition with JWT authentication
export const getOrdersHandler: LambdaDefinition<GetOrdersTies> = {
  id: 'get-orders',
  ties: {
    ordersService: OrdersService,  // Class constructor, NOT instance
  },
  handler: async (event, context) => {
    // The JWT token is validated by API Gateway before the handler executes.
    // If the token is invalid, API Gateway returns 401 — the handler is never invoked.
    // Claims from the validated token are available in event.requestContext.authorizer.

    const userId = event.pathParameters?.userId ?? '';

    if (!userId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing path parameter: userId' }),
      };
    }

    const orders = await event.ties.ordersService.getOrders(userId);

    return {
      statusCode: 200,
      body: JSON.stringify({ data: orders }),
    };
  },
  http: {
    method: 'GET',
    path: '/users/{userId}/orders',
    auth: {
      type: 'jwt',
      issuer: 'https://auth.example.com',
      audience: ['api.example.com'],
    },
  },
};
