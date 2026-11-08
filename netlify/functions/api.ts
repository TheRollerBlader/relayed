import { handlePublicRequest } from '../../services/gateway/publicHandler.ts'

export default function handler(req: Request) {
  return handlePublicRequest(req)
}

export const config = { path: '/api/*' }
