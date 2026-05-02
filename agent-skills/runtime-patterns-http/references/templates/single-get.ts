// =============================================================================
// Canonical Template: Single GET Endpoint
// Skill: runtime-patterns-http
// Use Case: Retrieve a single resource by ID via HTTP GET
// Framework: @worktif/runtime >=0.5.0 <1.0.0
// =============================================================================

import { LambdaDefinition } from '@worktif/runtime';

// Step 1: Define service classes
class ProductsService {
  async getProduct(id: string): Promise<{ id: string; name: string; price: number } | null> {
    // Implementation: query database, call external API, etc.
    return { id, name: 'Example Product', price: 29.99 };
  }
}

// Step 2: Define ties type (instance types for handler access)
type GetProductTies = {
  productsService: ProductsService;
};

// Step 3: Create Lambda definition with typed ties and http integration
export const getProductHandler: LambdaDefinition<GetProductTies> = {
  id: 'get-product',
  ties: {
    productsService: ProductsService,  // Class constructor, NOT instance
  },
  handler: async (event, context) => {
    // event.ties.productsService is fully typed as ProductsService instance
    const id = event.pathParameters?.id ?? '';

    if (!id) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing path parameter: id' }),
      };
    }

    const product = await event.ties.productsService.getProduct(id);

    if (!product) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: 'Product not found' }),
      };
    }

    return {
      statusCode: 200,
      body: JSON.stringify(product),
    };
  },
  http: {
    method: 'GET',
    path: '/products/{id}',
  },
};
