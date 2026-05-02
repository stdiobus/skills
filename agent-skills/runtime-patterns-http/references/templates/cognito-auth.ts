// =============================================================================
// Canonical Template: Cognito-Authenticated Endpoint
// Skill: runtime-patterns-http
// Use Case: HTTP endpoint protected by Amazon Cognito User Pool authorization
// Framework: @worktif/runtime >=0.5.0 <1.0.0
// =============================================================================

import { LambdaDefinition } from '@worktif/runtime';

// Step 1: Define service classes
class ProfileService {
  async getProfile(userId: string): Promise<{ id: string; name: string; email: string; plan: string }> {
    // Implementation: retrieve user profile from database
    return { id: userId, name: 'Jane Smith', email: 'jane@example.com', plan: 'premium' };
  }

  async updateProfile(userId: string, data: { name?: string; email?: string }): Promise<{ id: string; name: string; email: string; plan: string }> {
    // Implementation: update user profile in database
    return { id: userId, name: data.name ?? 'Jane Smith', email: data.email ?? 'jane@example.com', plan: 'premium' };
  }
}

// Step 2: Define ties type
type ProfileTies = {
  profileService: ProfileService;
};

// Step 3: Create Lambda definition with Cognito authentication (userPoolId + region)
export const getProfileHandler: LambdaDefinition<ProfileTies> = {
  id: 'get-profile',
  ties: {
    profileService: ProfileService,  // Class constructor, NOT instance
  },
  handler: async (event, context) => {
    // Cognito validates the token before the handler executes.
    // If the token is invalid or expired, API Gateway returns 401.
    // User claims are available in event.requestContext.authorizer.

    const userId = event.pathParameters?.userId ?? '';

    if (!userId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing path parameter: userId' }),
      };
    }

    const profile = await event.ties.profileService.getProfile(userId);

    return {
      statusCode: 200,
      body: JSON.stringify(profile),
    };
  },
  http: {
    method: 'GET',
    path: '/profile/{userId}',
    auth: {
      type: 'cognito',
      userPoolId: 'us-east-1_ExamplePool',
      region: 'us-east-1',
      userPoolClientIds: ['your-app-client-id'],
    },
  },
};

// Alternative: Cognito auth with explicit issuer URL
export const updateProfileHandler: LambdaDefinition<ProfileTies> = {
  id: 'update-profile',
  ties: {
    profileService: ProfileService,
  },
  handler: async (event, context) => {
    const userId = event.pathParameters?.userId ?? '';
    const data = JSON.parse(event.body ?? '{}');

    if (!userId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Missing path parameter: userId' }),
      };
    }

    const profile = await event.ties.profileService.updateProfile(userId, data);

    return {
      statusCode: 200,
      body: JSON.stringify(profile),
    };
  },
  http: {
    method: 'PUT',
    path: '/profile/{userId}',
    auth: {
      type: 'cognito',
      issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_ExamplePool',
      audience: ['your-app-client-id'],
    },
  },
};
