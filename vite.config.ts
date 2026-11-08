import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite'

function publicApi(): Plugin {
  return {
    name: 'relayaid-public-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || ''
        if (!url.startsWith('/api/') || url.startsWith('/api/investigate')) {
          next()
          return
        }
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          void (async () => {
            const { handlePublicRequest } = (await server.ssrLoadModule('/services/gateway/publicHandler.ts')) as {
              handlePublicRequest: (request: Request) => Promise<Response>
            }
            const headers = new Headers()
            if (typeof req.headers.authorization === 'string') headers.set('authorization', req.headers.authorization)
            if (typeof req.headers['content-type'] === 'string') headers.set('content-type', req.headers['content-type'])
            if (typeof req.headers['x-guest-capability'] === 'string') headers.set('x-guest-capability', req.headers['x-guest-capability'])
            const body = Buffer.concat(chunks)
            const request = new Request(`http://${req.headers.host}${url}`, {
              method: req.method,
              headers,
              body: req.method === 'GET' || req.method === 'HEAD' ? undefined : body,
            })
            const response = await handlePublicRequest(request)
            res.statusCode = response.status
            response.headers.forEach((value, key) => res.setHeader(key, value))
            res.end(Buffer.from(await response.arrayBuffer()))
          })().catch(() => {
            res.statusCode = 500
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ error: 'REQUEST_FAILED' }))
          })
        })
      })
    },
  }
}

function investigateApi(env: Record<string, string>): Plugin {
  return {
    name: 'relayaid-investigate',
    configureServer(server: ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== '/api/investigate' || req.method !== 'POST') {
          next()
          return
        }
        const chunks: Buffer[] = []
        req.on('data', (chunk: Buffer) => chunks.push(chunk))
        req.on('end', () => {
          void (async () => {
            try {
              const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { shelterId?: string }
              const shelterId = body.shelterId === 'shelter-b' ? 'shelter-b' : 'shelter-a'
              const [{ investigate }, { executeLocalTool }] = await Promise.all([
                server.ssrLoadModule('/worker/src/index.ts') as Promise<{
                  investigate: (
                    env: Record<string, string | undefined>,
                    execute: (name: string, args: Record<string, unknown>) => Promise<unknown>,
                    fetchImpl: typeof fetch,
                    timeBudgetMs: number,
                  ) => Promise<{ nemotron: boolean; outcome: string; explanation: string; trace: string[] }>
                }>,
                server.ssrLoadModule('/worker/src/localDesk.ts') as Promise<{
                  executeLocalTool: (shelterId: string, name: string, args: Record<string, unknown>) => Promise<unknown>
                }>,
              ])
              const result = await investigate(
                {
                  NEMOTRON_BASE_URL: env.NEMOTRON_BASE_URL,
                  NEMOTRON_API_KEY: env.NEMOTRON_API_KEY,
                  NEMOTRON_MODEL: env.NEMOTRON_MODEL,
                  RELAYAID_SHELTER_ID: shelterId,
                },
                (name, args) => executeLocalTool(shelterId, name, args),
                fetch,
                45_000,
              )
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({
                nemotron: result.nemotron,
                outcome: result.outcome,
                explanation: result.explanation,
                trace: result.trace,
              }))
            } catch (error) {
              const secret = env.NEMOTRON_API_KEY
              let text = error instanceof Error ? error.message : 'Assistant request failed'
              if (secret) text = text.split(secret).join('')
              res.statusCode = 500
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ nemotron: false, outcome: 'fallback', explanation: text.slice(0, 200), trace: [] }))
            }
          })()
        })
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react(), tailwindcss(), investigateApi(env), publicApi()],
  }
})
