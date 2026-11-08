import { useMemo } from 'react'
import { AuthProvider, useAuth } from 'react-oidc-context'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { SpacetimeDBProvider } from 'spacetimedb/react'
import { RoleGate } from './components/RoleGate'
import { Shell } from './components/Shell'
import { DbConnection } from './module_bindings/index.ts'
import { demoMode, oidcAuthority, oidcClientId, spacetimeDb, spacetimeEnabled, spacetimeUri } from './lib/config.ts'
import { bindOutbox } from './lib/outboxClient.ts'
import { readToken, saveToken, setLink, setOwner } from './lib/session.ts'
import { AccessView } from './views/AccessView'
import { HomeView } from './views/HomeView'
import { JoinView } from './views/JoinView'
import { PlanDetailView } from './views/PlanDetailView'
import { AidView } from './views/AidView'
import { BoardView } from './views/BoardView'
import { PlansView } from './views/PlansView'
import { QueueView } from './views/QueueView'
import { ReceiptView } from './views/ReceiptView'
import { RequestDetailView } from './views/RequestDetailView'
import { RequestView } from './views/RequestView'
import { RequestsView } from './views/RequestsView'
import { ResourcesView } from './views/ResourcesView'
import { TaskDetailView } from './views/TaskDetailView'
import { TasksView } from './views/TasksView'
import { TimelineView } from './views/TimelineView'
import { OutboxSync } from './views/OutboxSync'
import ResponseDesk, { EmergencyAction, type SessionAuth } from './response/ResponseApp.tsx'

function DeskRoutes() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Shell />}>
          <Route index element={<HomeView />} />
          <Route path="access" element={<AccessView />} />
          <Route path="join/:inviteId" element={<JoinView />} />
          <Route element={<RoleGate role="resident" />}>
            <Route element={<OutboxSync />}>
              <Route path="r/request" element={<RequestView />} />
              <Route path="r/requests" element={<RequestsView />} />
              <Route path="r/requests/:clientRequestId" element={<ReceiptView />} />
            </Route>
          </Route>
          <Route element={<RoleGate role="coordinator" />}>
            <Route path="c/queue" element={<QueueView />} />
            <Route path="c/board" element={<BoardView />} />
            <Route path="c/aid" element={<AidView />} />
            <Route path="c/requests/:requestPk" element={<RequestDetailView />} />
            <Route path="c/resources" element={<ResourcesView />} />
            <Route path="c/plans" element={<PlansView />} />
            <Route path="c/plans/:planId" element={<PlanDetailView />} />
            <Route path="c/timeline" element={<TimelineView />} />
          </Route>
          <Route element={<RoleGate role="volunteer" />}>
            <Route path="v/tasks" element={<TasksView />} />
            <Route path="v/tasks/:assignmentId" element={<TaskDetailView />} />
          </Route>
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

function DeskApp({ tokenProvider }: { tokenProvider?: () => Promise<string> }) {
  const connectionBuilder = useMemo(() => {
    let builder = DbConnection.builder()
      .withUri(spacetimeEnabled ? spacetimeUri : 'ws://127.0.0.1:9')
      .withDatabaseName(spacetimeDb || 'relayaid-demo')
      .onConnect((_connection, identity, token) => {
        if (demoMode) saveToken(token)
        const owner = identity.toHexString()
        setOwner(owner)
        void bindOutbox(owner, localStorage.getItem('relayaid-shelter') || 'shelter-a')
        setLink('online')
      })
      .onAutomaticReconnect((_connection, identity, token) => {
        if (demoMode) saveToken(token)
        const owner = identity.toHexString()
        setOwner(owner)
        void bindOutbox(owner, localStorage.getItem('relayaid-shelter') || 'shelter-a')
        setLink('online')
      })
      .onConnectError(() => setLink('offline'))
      .onDisconnect((_ctx, _error, attempt) => setLink(attempt ? 'reconnecting' : 'offline'))
    if (spacetimeEnabled) builder = builder.withAutomaticReconnect()
    if (tokenProvider) return builder.withTokenProvider(tokenProvider)
    return builder.withToken(readToken())
  }, [tokenProvider])

  return (
    <SpacetimeDBProvider connectionBuilder={connectionBuilder}>
      <DeskRoutes />
    </SpacetimeDBProvider>
  )
}

function authBridge(auth: ReturnType<typeof useAuth>): SessionAuth {
  return {
    configured: true,
    isLoading: auth.isLoading,
    error: auth.error,
    isAuthenticated: Boolean(auth.isAuthenticated),
    accessToken: auth.user?.access_token || '',
    signIn: async () => {
      await auth.signinRedirect()
    },
    signOut: async () => {
      await auth.signoutRedirect()
    },
  }
}

function OidcFront() {
  const auth = useAuth()
  const token = auth.user?.id_token
  const tokenProvider = useMemo(() => (token ? async () => token : undefined), [token])
  return (
    <>
      <EmergencyAction />
      <ResponseDesk legacy={<DeskApp tokenProvider={tokenProvider} />} auth={authBridge(auth)} />
    </>
  )
}

export default function App() {
  if (!oidcClientId) {
    return (
      <>
        <EmergencyAction />
        <ResponseDesk
          legacy={<DeskApp />}
          auth={{
            configured: false,
            isLoading: false,
            isAuthenticated: false,
            accessToken: '',
            signIn: async () => undefined,
            signOut: async () => undefined,
          }}
        />
      </>
    )
  }
  return (
    <AuthProvider
      authority={oidcAuthority}
      client_id={oidcClientId}
      redirect_uri={window.location.origin}
      response_type="code"
      scope="openid profile email"
      onSigninCallback={() => {
        window.history.replaceState({}, document.title, window.location.pathname)
      }}
    >
      <OidcFront />
    </AuthProvider>
  )
}
