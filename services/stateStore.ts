import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { seedState } from './localAutonomy.ts'
import { hydrate, initialState, type State } from '../shared/autonomy/contracts.ts'

const file = process.env.AUTONOMY_STATE_FILE || (process.env['AWS_LAMBDA_FUNCTION_NAME'] ? '/tmp/relayaid-autonomy-state.json' : 'runtime/generated/autonomy-state.json')
const blobName = 'relayaid-autonomy'
let chain: Promise<void> = Promise.resolve()

function onNetlify() {
  const env = process.env
  return Boolean(env['NETLIFY'] || env['AWS_LAMBDA_FUNCTION_NAME'] || env['LAMBDA_TASK_ROOT'])
}

function sidePath(key: string) {
  return `${file}.${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

async function blobStore() {
  const { getStore } = await import('@netlify/blobs')
  return getStore({ name: blobName, consistency: 'strong' })
}

async function readState(): Promise<State> {
  if (onNetlify()) {
    const saved = (await (await blobStore()).get('state', { type: 'json' })) as State | null
    return hydrate(saved ?? seedState(initialState()))
  }
  try {
    return hydrate(JSON.parse(readFileSync(file, 'utf8')) as State)
  } catch {
    return seedState(initialState())
  }
}

async function writeState(state: State) {
  if (onNetlify()) {
    await (await blobStore()).setJSON('state', state)
    return
  }
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.tmp`
  writeFileSync(temp, JSON.stringify(state))
  renameSync(temp, file)
}

export function updateState(change: (state: State) => State | Promise<State>): Promise<State> {
  const run = chain.then(async () => {
    const next = await change(await readState())
    await writeState(next)
    return next
  })
  chain = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export async function readSide(key: string): Promise<string | null> {
  if (onNetlify()) return (await blobStore()).get(key)
  try {
    return readFileSync(sidePath(key), 'utf8')
  } catch {
    return null
  }
}

export async function writeSide(key: string, value: string) {
  if (onNetlify()) {
    await (await blobStore()).set(key, value)
    return
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(sidePath(key), value)
}
