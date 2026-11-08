import { SenderError } from 'spacetimedb'
import { useSpacetimeDB } from 'spacetimedb/react'
import type { DbConnection } from '../module_bindings/index.ts'
import { errorSentence } from './copy.ts'
import { denyAccess } from './session.ts'

const CODES = [
  'UNAUTHORIZED',
  'WRONG_SHELTER',
  'INVALID_TRANSITION',
  'STALE_PLAN',
  'ALREADY_APPROVED',
  'INSUFFICIENT_CAPACITY',
  'IDEMPOTENCY_CONFLICT',
  'INVALID_INPUT',
  'NOT_FOUND',
  'STALE_OFFER',
  'RATE_LIMIT',
] as const

export function errorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return CODES.find((code) => message.includes(code)) ?? message
}

export function errorText(error: unknown): string {
  return errorSentence(errorCode(error))
}

export function isSenderError(error: unknown): boolean {
  return error instanceof SenderError || (error instanceof Error && CODES.some((code) => error.message.includes(code)))
}

export function useConnection(): DbConnection | null {
  const { getConnection, isActive } = useSpacetimeDB()
  if (!isActive) return null
  return (getConnection() as DbConnection | undefined) ?? null
}

export async function runReducer(
  connection: DbConnection | null,
  call: (connection: DbConnection) => Promise<void>,
): Promise<{ ok: true } | { ok: false; code: string; text: string }> {
  if (!connection) return { ok: false, code: 'OFFLINE', text: 'Not connected. Try again when you are back online.' }
  try {
    await call(connection)
    return { ok: true }
  } catch (error) {
    const code = errorCode(error)
    const text = errorSentence(code)
    if (code === 'UNAUTHORIZED' || code === 'WRONG_SHELTER') denyAccess(text)
    return { ok: false, code, text }
  }
}
