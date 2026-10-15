// Shared constants — routes, roles, limits
//
// The AUTH block that used to sit here is gone: Supabase Auth owns register,
// login and logout, this API never issues or validates a password, and nothing
// in either workspace referenced these constants.

export const API_ROUTES = {
  HEALTH: '/health',
  USERS: {
    BASE: '/users',
    BY_ID: (id: string) => `/users/${id}`,
  },
  ANNOUNCEMENTS: {
    BASE: '/announcements',
    BY_ID: (id: string) => `/announcements/${id}`,
  },
  SERVICES: {
    BASE: '/services',
    BY_ID: (id: string) => `/services/${id}`,
  },
  CONTACT: {
    BASE: '/contact',
  },
} as const;

export const PAGINATION_DEFAULTS = {
  PAGE: 1,
  LIMIT: 10,
  MAX_LIMIT: 100,
} as const;
