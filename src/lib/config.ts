export const shelterId = import.meta.env.VITE_SHELTER_ID || 'shelter-a'

export const SHELTERS = [
  { id: 'shelter-a', name: 'North Hall' },
  { id: 'shelter-b', name: 'South Hall' },
] as const

export type ShelterId = (typeof SHELTERS)[number]['id']

export const spacetimeUri = import.meta.env.VITE_SPACETIME_URI || ''

export const spacetimeEnabled = spacetimeUri.length > 0

export const spacetimeDb = import.meta.env.VITE_SPACETIME_DB_NAME || 'relayaid-demo'

export const demoMode = import.meta.env.VITE_DEMO_MODE !== 'false'

export const oidcAuthority = import.meta.env.VITE_OIDC_AUTHORITY || 'https://auth.spacetimedb.com/oidc'

export const oidcClientId = import.meta.env.VITE_OIDC_CLIENT_ID || ''

export const HALL_POINTS = {
  'shelter-a': { name: 'North Hall', lat: 32.78, lon: -96.8 },
  'shelter-b': { name: 'South Hall', lat: 32.77, lon: -96.79 },
} as const

export const roleLabels = {
  resident: 'Jordan Hale',
  coordinator: 'Desk lead',
  volunteer: 'Floor volunteer',
} as const

export type DemoRole = keyof typeof roleLabels

export function homeFor(role: DemoRole): string {
  if (role === 'resident') return '/r/request'
  if (role === 'coordinator') return '/c/queue'
  return '/v/tasks'
}
