import { useSyncExternalStore } from 'react'
import { shelterId as defaultShelter, spacetimeEnabled, type DemoRole, type ShelterId } from './config'

const ROLE_KEY = 'relayaid-demo-role'
const TOKEN_KEY = 'relayaid-auth-token'
const DEVICE_KEY = 'relayaid-device-offline'
const SHELTER_KEY = 'relayaid-shelter'
const OWNER_KEY = 'relayaid-owner'

export type LinkState = 'connecting' | 'online' | 'reconnecting' | 'offline'

type Session = {
  role: DemoRole | null
  shelterId: ShelterId
  link: LinkState
  lastUpdate: number | null
  deviceOffline: boolean
  accessReason: string | null
  ownerIdentity: string
}

let session: Session = {
  role: readRole(),
  shelterId: readShelter(),
  link: spacetimeEnabled ? 'connecting' : 'offline',
  lastUpdate: null,
  deviceOffline: sessionStorage.getItem(DEVICE_KEY) === '1',
  accessReason: null,
  ownerIdentity: localStorage.getItem(OWNER_KEY) ?? '',
}

const listeners = new Set<() => void>()

function emit() {
  listeners.forEach((listener) => listener())
}

function readShelter(): ShelterId {
  const value = localStorage.getItem(SHELTER_KEY)
  if (value === 'shelter-a' || value === 'shelter-b') return value
  return defaultShelter === 'shelter-b' ? 'shelter-b' : 'shelter-a'
}

function readRole(): DemoRole | null {
  const value = localStorage.getItem(ROLE_KEY)
  if (value === 'resident' || value === 'coordinator' || value === 'volunteer') return value
  return null
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useSession(): Session {
  return useSyncExternalStore(subscribe, () => session, () => session)
}

export function setShelter(shelterId: ShelterId) {
  localStorage.setItem(SHELTER_KEY, shelterId)
  session = { ...session, shelterId }
  emit()
}

export function setDemoRole(role: DemoRole | null) {
  if (role) localStorage.setItem(ROLE_KEY, role)
  else localStorage.removeItem(ROLE_KEY)
  session = { ...session, role }
  emit()
}

export function setLink(link: LinkState) {
  session = { ...session, link, lastUpdate: link === 'online' ? Date.now() : session.lastUpdate }
  emit()
}

export function touchLink() {
  session = { ...session, lastUpdate: Date.now() }
  emit()
}

export function setDeviceOffline(offline: boolean) {
  sessionStorage.setItem(DEVICE_KEY, offline ? '1' : '0')
  session = { ...session, deviceOffline: offline }
  emit()
}

export function setOwner(ownerIdentity: string) {
  if (ownerIdentity) localStorage.setItem(OWNER_KEY, ownerIdentity)
  else localStorage.removeItem(OWNER_KEY)
  session = { ...session, ownerIdentity }
  emit()
}

export function readToken(): string | undefined {
  return localStorage.getItem(TOKEN_KEY) ?? undefined
}

export function saveToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token)
}

export function denyAccess(reason: string) {
  localStorage.removeItem(ROLE_KEY)
  session = { ...session, role: null, accessReason: reason }
  emit()
}

export function clearAccessReason() {
  session = { ...session, accessReason: null }
  emit()
}

export function clearDeviceStorage() {
  localStorage.removeItem(ROLE_KEY)
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(SHELTER_KEY)
  localStorage.removeItem(OWNER_KEY)
  sessionStorage.removeItem(DEVICE_KEY)
  session = {
    role: null,
    shelterId: 'shelter-a',
    link: session.link,
    lastUpdate: null,
    deviceOffline: false,
    accessReason: null,
    ownerIdentity: '',
  }
  emit()
}

export function canUseServer(state: Session = session): boolean {
  return state.link === 'online' && !state.deviceOffline
}
