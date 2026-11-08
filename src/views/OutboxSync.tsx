import { useEffect, useRef } from 'react'
import { Outlet } from 'react-router-dom'
import { tables } from '../module_bindings/index.ts'
import { serverSentence } from '../lib/copy.ts'
import { expireNow, markChecking, markConflict, markRefused, markSending, markServer, unsent, useOutbox } from '../lib/outboxClient.ts'
import { useSession } from '../lib/session.ts'
import { useConnection, runReducer } from '../lib/server.ts'
import { useRows } from '../lib/tables.ts'

export function OutboxSync() {
  const connection = useConnection()
  const session = useSession()
  const { items } = useOutbox()
  const [requests] = useRows(tables.myRequests)
  const busy = useRef(false)

  useEffect(() => {
    for (const row of requests) {
      const version = Number(row.stateVersion)
      const local = items.find((item) => item.clientRequestId === row.clientRequestId)
      if (!local || local.confirmedStateVersion > version) continue
      if (local.status === 'delivered' && local.confirmedStateVersion === version && local.notice === serverSentence(row.state, row.cancelReason)) {
        continue
      }
      void markServer(row.clientRequestId, version, serverSentence(row.state, row.cancelReason))
    }
  }, [items, requests])

  useEffect(() => {
    if (!connection || session.deviceOffline || busy.current) return
    const queue = unsent()
    if (queue.length === 0) return
    busy.current = true
    void (async () => {
      for (const item of queue) {
        await markSending(item.clientRequestId)
        const result = await runReducer(connection, (current) =>
          current.reducers.submitRequest({
            shelterId: item.shelterId,
            clientRequestId: item.clientRequestId,
            kind: item.kind,
            needs: item.needs,
            quantity: item.quantity,
            clientCreatedAt: item.clientCreatedAt,
          }),
        )
        if (!result.ok && result.code === 'IDEMPOTENCY_CONFLICT') await markConflict(item.clientRequestId)
        else if (!result.ok && (result.code === 'INVALID_INPUT' || result.code === 'UNAUTHORIZED' || result.code === 'WRONG_SHELTER' || result.code === 'NOT_FOUND')) {
          await markRefused(item.clientRequestId, result.code)
        } else if (!result.ok) await markChecking(item.clientRequestId)
      }
      busy.current = false
    })()
  }, [connection, items, session.deviceOffline])

  useEffect(() => {
    const expire = () => void expireNow()
    expire()
    const timer = window.setInterval(expire, 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (connection) void expireNow()
  }, [connection])

  return <Outlet />
}
