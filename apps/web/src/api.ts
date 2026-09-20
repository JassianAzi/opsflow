import type {
  OrganizationMember,
  OrganizationSummary,
  PublicUser,
} from '@opsflow/shared';

interface ApiFailure {
  error?: { message?: string };
}

async function request<T>(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<T> {
  const options: RequestInit = {
    method,
    credentials: 'same-origin',
  };
  if (body !== undefined) {
    options.headers = { 'Content-Type': 'application/json' };
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  if (response.status === 204) return undefined as T;
  const payload: unknown = await response.json();
  if (!response.ok) {
    const failure = payload as ApiFailure;
    throw new Error(failure.error?.message || 'The request failed.');
  }
  return payload as T;
}

export const api = {
  register(email: string, password: string, displayName: string) {
    return request<{ user: PublicUser }>('/api/auth/register', 'POST', {
      email,
      password,
      displayName,
    });
  },
  login(email: string, password: string) {
    return request<{ user: PublicUser }>('/api/auth/login', 'POST', {
      email,
      password,
    });
  },
  logout() {
    return request<void>('/api/auth/logout', 'POST');
  },
  me() {
    return request<{ user: PublicUser }>('/api/auth/me');
  },
  organizations() {
    return request<{ organizations: OrganizationSummary[] }>(
      '/api/organizations',
    );
  },
  createOrganization(name: string) {
    return request<{ organization: OrganizationSummary }>(
      '/api/organizations',
      'POST',
      { name },
    );
  },
  organization(id: string) {
    return request<{ organization: OrganizationSummary }>(
      `/api/organizations/${id}`,
    );
  },
  members(id: string) {
    return request<{ members: OrganizationMember[] }>(
      `/api/organizations/${id}/members`,
    );
  },
};
