// =============================================================================
// Canonical Template: CRUD Microservice
// Skill: runtime-patterns-http
// Use Case: Complete CRUD API with multiple endpoints in a single microservice
// Framework: @worktif/runtime >=0.5.0 <1.0.0
// =============================================================================

import { MicroserviceDefinition, LambdaDefinition } from '@worktif/runtime';

// Step 1: Define service classes
class UsersService {
  async listUsers(page: number, limit: number): Promise<{ id: string; name: string; email: string }[]> {
    // Implementation: query database with pagination
    return [];
  }

  async getUser(id: string): Promise<{ id: string; name: string; email: string } | null> {
    // Implementation: query database by ID
    return { id, name: 'John Doe', email: 'john@example.com' };
  }

  async createUser(data: { name: string; email: string }): Promise<{ id: string; name: string; email: string }> {
    // Implementation: insert into database
    return { id: 'new-id', ...data };
  }

  async updateUser(id: string, data: { name?: string; email?: string }): Promise<{ id: string; name: string; email: string }> {
    // Implementation: update database record
    return { id, name: data.name ?? 'Updated', email: data.email ?? 'updated@example.com' };
  }

  async deleteUser(id: string): Promise<void> {
    // Implementation: delete from database
  }
}

// Step 2: Define Ties class for microservice-level DI registration
class UsersTies {
  static register(container: any) {
    container.tie('usersService', UsersService, []);
  }
}

// Step 3: Define ties types for each handler
type ListUsersTies = { usersService: UsersService };
type GetUserTies = { usersService: UsersService };
type CreateUserTies = { usersService: UsersService };
type UpdateUserTies = { usersService: UsersService };
type DeleteUserTies = { usersService: UsersService };

// Step 4: Create Lambda definitions for each CRUD operation

const listUsersHandler: LambdaDefinition<ListUsersTies> = {
  id: 'list-users',
  ties: { usersService: UsersService },
  handler: async (event, context) => {
    const page = parseInt(event.queryStringParameters?.page ?? '1', 10);
    const limit = parseInt(event.queryStringParameters?.limit ?? '20', 10);

    const users = await event.ties.usersService.listUsers(page, limit);

    return {
      statusCode: 200,
      body: JSON.stringify({ data: users, page, limit }),
    };
  },
  http: { method: 'GET', path: '/users' },
};

const getUserHandler: LambdaDefinition<GetUserTies> = {
  id: 'get-user',
  ties: { usersService: UsersService },
  handler: async (event, context) => {
    const id = event.pathParameters?.id ?? '';

    if (!id) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing path parameter: id' }) };
    }

    const user = await event.ties.usersService.getUser(id);

    if (!user) {
      return { statusCode: 404, body: JSON.stringify({ error: 'User not found' }) };
    }

    return { statusCode: 200, body: JSON.stringify(user) };
  },
  http: { method: 'GET', path: '/users/{id}' },
};

const createUserHandler: LambdaDefinition<CreateUserTies> = {
  id: 'create-user',
  ties: { usersService: UsersService },
  handler: async (event, context) => {
    const data = JSON.parse(event.body ?? '{}');

    if (!data.name || !data.email) {
      return { statusCode: 400, body: JSON.stringify({ error: 'name and email are required' }) };
    }

    const user = await event.ties.usersService.createUser(data);

    return { statusCode: 201, body: JSON.stringify(user) };
  },
  http: { method: 'POST', path: '/users' },
};

const updateUserHandler: LambdaDefinition<UpdateUserTies> = {
  id: 'update-user',
  ties: { usersService: UsersService },
  handler: async (event, context) => {
    const id = event.pathParameters?.id ?? '';
    const data = JSON.parse(event.body ?? '{}');

    if (!id) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing path parameter: id' }) };
    }

    const user = await event.ties.usersService.updateUser(id, data);

    return { statusCode: 200, body: JSON.stringify(user) };
  },
  http: { method: 'PUT', path: '/users/{id}' },
};

const deleteUserHandler: LambdaDefinition<DeleteUserTies> = {
  id: 'delete-user',
  ties: { usersService: UsersService },
  handler: async (event, context) => {
    const id = event.pathParameters?.id ?? '';

    if (!id) {
      return { statusCode: 400, body: JSON.stringify({ error: 'Missing path parameter: id' }) };
    }

    await event.ties.usersService.deleteUser(id);

    return { statusCode: 204, body: '' };
  },
  http: { method: 'DELETE', path: '/users/{id}' },
};

// Step 5: Assemble the microservice definition
export const usersService: MicroserviceDefinition = {
  ties: [UsersTies],
  lambdas: [listUsersHandler, getUserHandler, createUserHandler, updateUserHandler, deleteUserHandler],
};
