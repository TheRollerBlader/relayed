import { schema, table, t } from 'spacetimedb/server';

export const shelter = table(
  { name: 'shelter' },
  {
    shelterId: t.string().primaryKey(),
    name: t.string(),
    status: t.string(),
    confirmWater: t.bool(),
    confirmCharging: t.bool(),
  },
);

export const member = table(
  { name: 'member' },
  {
    identity: t.identity().primaryKey(),
    shelterId: t.string().index('btree'),
    role: t.string(),
    displayLabel: t.string(),
    grantedBy: t.identity(),
    active: t.bool(),
  },
);

export const moduleConfig = table(
  { name: 'module_config' },
  {
    configId: t.string().primaryKey(),
    authMode: t.string(),
    aiMode: t.string(),
    oidcIssuer: t.string(),
    oidcAudience: t.string(),
    bootstrapAdminSub: t.string(),
  },
);

export const invite = table(
  { name: 'invite', indexes: [{ accessor: 'byShelter', algorithm: 'btree', columns: ['shelterId'] }] },
  {
    inviteId: t.string().primaryKey(),
    shelterId: t.string(),
    role: t.string(),
    taskId: t.string(),
    expiresAt: t.timestamp(),
    maxUses: t.u32(),
    useCount: t.u32(),
    createdBy: t.identity(),
    active: t.bool(),
  },
);

export const helpRequest = table(
  {
    name: 'help_request',
    indexes: [
      {
        accessor: 'byShelterState',
        algorithm: 'btree',
        columns: ['shelterId', 'state'],
      },
    ],
  },
  {
    requestPk: t.u64().primaryKey().autoInc(),
    shelterId: t.string(),
    clientRequestId: t.string(),
    idempotencyKey: t.string().unique(),
    residentIdentity: t.identity().index('btree'),
    kind: t.string(),
    needs: t.string(),
    quantity: t.u32(),
    payloadHash: t.string(),
    clientCreatedAt: t.string(),
    receivedAt: t.timestamp(),
    updatedAt: t.timestamp(),
    serveBy: t.timestamp(),
    state: t.string(),
    stateVersion: t.u64(),
    humanPriority: t.u32(),
    priorityReason: t.string(),
    cancelReason: t.string(),
    confirmation: t.string(),
    fulfilledUnits: t.u32(),
    backorderOf: t.u64(),
  },
);

export const resource = table(
  { name: 'resource' },
  {
    resourceId: t.string().primaryKey(),
    shelterId: t.string().index('btree'),
    kind: t.string(),
    accessible: t.bool(),
    capacityTotal: t.u32(),
    available: t.u32(),
    reserved: t.u32(),
    version: t.u64(),
  },
);

export const plan = table(
  { name: 'plan' },
  {
    planId: t.u64().primaryKey().autoInc(),
    shelterId: t.string().index('btree'),
    strategy: t.string(),
    inputSnapshotVersion: t.u64(),
    createdByRole: t.string(),
    status: t.string(),
    hypothetical: t.bool(),
    summary: t.string(),
    policy: t.string(),
    method: t.string(),
  },
);

export const planRequestPin = table(
  { name: 'plan_request_pin' },
  {
    pinId: t.u64().primaryKey().autoInc(),
    planId: t.u64().index('btree'),
    requestPk: t.u64(),
    stateVersion: t.u64(),
  },
);

export const planResourcePin = table(
  { name: 'plan_resource_pin' },
  {
    pinId: t.u64().primaryKey().autoInc(),
    planId: t.u64().index('btree'),
    resourceId: t.string(),
    version: t.u64(),
  },
);

export const planAssignment = table(
  { name: 'plan_assignment' },
  {
    rowId: t.u64().primaryKey().autoInc(),
    planId: t.u64().index('btree'),
    requestPk: t.u64(),
    resourceId: t.string(),
    units: t.u32(),
  },
);

export const planUnmatched = table(
  { name: 'plan_unmatched' },
  {
    rowId: t.u64().primaryKey().autoInc(),
    planId: t.u64().index('btree'),
    requestPk: t.u64(),
    reason: t.string(),
  },
);

export const assignment = table(
  { name: 'assignment' },
  {
    assignmentId: t.u64().primaryKey().autoInc(),
    shelterId: t.string().index('btree'),
    planId: t.u64(),
    requestPk: t.u64().index('btree'),
    resourceId: t.string(),
    units: t.u32(),
    volunteerSet: t.bool(),
    volunteerIdentity: t.identity().index('btree'),
    state: t.string(),
    dispatchState: t.string(),
    dispatchVersion: t.u64(),
    dueAt: t.timestamp(),
    declineReason: t.string(),
    openedAt: t.timestamp(),
    deliveredAt: t.timestamp(),
  },
);

export const shelterVersion = table(
  { name: 'shelter_version' },
  {
    shelterId: t.string().primaryKey(),
    snapshotVersion: t.u64(),
  },
);

export const event = table(
  { name: 'event' },
  {
    eventId: t.u64().primaryKey().autoInc(),
    shelterId: t.string().index('btree'),
    at: t.timestamp(),
    actorIdentity: t.identity(),
    type: t.string(),
    subjectId: t.string(),
    correlationId: t.string(),
    details: t.string(),
  },
);

export const modelRun = table(
  { name: 'model_run' },
  {
    runId: t.string().primaryKey(),
    shelterId: t.string().index('btree'),
    correlationId: t.string(),
    toolCalls: t.string(),
    outcome: t.string(),
    explanation: t.string(),
    startedAt: t.timestamp(),
    endedAt: t.timestamp(),
  },
);

export const aiJob = table(
  { name: 'ai_job' },
  {
    jobId: t.u64().primaryKey().autoInc(),
    jobClientId: t.string().unique(),
    shelterId: t.string().index('btree'),
    requester: t.identity().index('btree'),
    state: t.string(),
    snapshotVersion: t.u64(),
    leaseOwner: t.identity(),
    leaseExpiresAt: t.timestamp(),
    explanation: t.string(),
    rejectReason: t.string(),
    live: t.bool(),
    createdAt: t.timestamp(),
    updatedAt: t.timestamp(),
  },
);

export const aiJobLease = table({ name: 'ai_job_lease' }, { jobId: t.u64().primaryKey(), fence: t.u64() });

export const aiJobEvent = table(
  { name: 'ai_job_event' },
  {
    eventId: t.u64().primaryKey().autoInc(),
    jobId: t.u64().index('btree'),
    shelterId: t.string().index('btree'),
    seq: t.u32(),
    toolName: t.string(),
    inputSummary: t.string(),
    resultRef: t.string(),
    resultSummary: t.string(),
    live: t.bool(),
    at: t.timestamp(),
  },
);

export const taskLocationLatest = table(
  { name: 'task_location_latest' },
  {
    subjectKey: t.string().primaryKey(),
    shelterId: t.string().index('btree'),
    partnerShelterId: t.string(),
    subjectKind: t.string(),
    subjectId: t.u64(),
    volunteerIdentity: t.identity(),
    seq: t.u64(),
    lat: t.f64(),
    lon: t.f64(),
    accuracyM: t.f64(),
    capturedAt: t.string(),
    receivedAt: t.timestamp(),
    sharing: t.bool(),
    coarse: t.string(),
    source: t.string(),
  },
);

export const volunteerProfile = table(
  { name: 'volunteer_profile' },
  {
    identity: t.identity().primaryKey(),
    shelterId: t.string().index('btree'),
    available: t.bool(),
    canCarryWater: t.bool(),
    chargerEscort: t.bool(),
    zone: t.string(),
  },
);

export const actionReceipt = table(
  { name: 'action_receipt' },
  {
    actionId: t.string().primaryKey(),
    subjectId: t.string(),
    action: t.string(),
  },
);

export const transfer = table(
  { name: 'transfer', indexes: [{ accessor: 'bySource', algorithm: 'btree', columns: ['sourceShelterId'] }] },
  {
    transferId: t.u64().primaryKey().autoInc(),
    sourceShelterId: t.string(),
    destShelterId: t.string().index('btree'),
    kind: t.string(),
    quantityRequested: t.u32(),
    quantityOffered: t.u32(),
    quantityReceived: t.u32(),
    quantityLost: t.u32(),
    inTransit: t.u32(),
    state: t.string(),
    sourceResourceId: t.string(),
    destResourceId: t.string(),
    sourceVersion: t.u64(),
    sourceApproved: t.bool(),
    destApproved: t.bool(),
    responsibleSet: t.bool(),
    responsibleVolunteer: t.identity(),
    volunteerState: t.string(),
    declineReason: t.string(),
    assignmentId: t.u64(),
  },
);

export const followUp = table(
  { name: 'follow_up' },
  {
    followUpId: t.u64().primaryKey().autoInc(),
    shelterId: t.string().index('btree'),
    requestPk: t.u64(),
    reason: t.string(),
    ownerSet: t.bool(),
    ownerIdentity: t.identity(),
    deadline: t.timestamp(),
    state: t.string(),
  },
);

export const observation = table(
  { name: 'observation' },
  {
    observationId: t.u64().primaryKey().autoInc(),
    shelterId: t.string().index('btree'),
    kind: t.string(),
    resourceKind: t.string(),
    units: t.u32(),
    at: t.timestamp(),
    durationMicros: t.u64(),
  },
);

export const approvalReceipt = table(
  { name: 'approval_receipt' },
  {
    approvalId: t.string().primaryKey(),
    planId: t.u64(),
    shelterId: t.string(),
    outcome: t.string(),
  },
);

export const whatIfAdd = t.object('WhatIfAdd', {
  kind: t.string(),
  accessible: t.bool(),
  count: t.u32(),
});

export const queueRow = t.row('QueueRow', {
  requestPk: t.u64().primaryKey(),
  shelterId: t.string(),
  clientRequestId: t.string(),
  residentLabel: t.string(),
  kind: t.string(),
  needs: t.string(),
  quantity: t.u32(),
  state: t.string(),
  stateVersion: t.u64(),
  receivedAt: t.timestamp(),
  waitReason: t.string(),
  queueRank: t.u32(),
  humanPriority: t.u32(),
  priorityReason: t.string(),
  cancelReason: t.string(),
  updatedAt: t.timestamp(),
  serveBy: t.timestamp(),
  overdue: t.bool(),
  confirmation: t.string(),
});

export const planDetailRow = t.row('PlanDetailRow', {
  lineId: t.string().primaryKey(),
  planId: t.u64(),
  strategy: t.string(),
  status: t.string(),
  hypothetical: t.bool(),
  summary: t.string(),
  inputSnapshotVersion: t.u64(),
  liveSnapshotVersion: t.u64(),
  lineKind: t.string(),
  requestPk: t.u64(),
  resourceId: t.string(),
  units: t.u32(),
  reason: t.string(),
  residentLabel: t.string(),
  requestKind: t.string(),
  needs: t.string(),
  policy: t.string(),
  method: t.string(),
});

export const assignmentRow = t.row('AssignmentRow', {
  assignmentId: t.u64().primaryKey(),
  requestPk: t.u64(),
  residentLabel: t.string(),
  kind: t.string(),
  units: t.u32(),
  state: t.string(),
  resourceId: t.string(),
  accessible: t.bool(),
  dispatchState: t.string(),
  dispatchVersion: t.u64(),
  declineReason: t.string(),
  volunteerLabel: t.string(),
  dueAt: t.timestamp(),
});

export const transferRow = t.row('TransferRow', {
  transferId: t.u64().primaryKey(),
  sourceShelterId: t.string(),
  destShelterId: t.string(),
  sourceName: t.string(),
  destName: t.string(),
  kind: t.string(),
  quantityRequested: t.u32(),
  quantityOffered: t.u32(),
  quantityReceived: t.u32(),
  quantityLost: t.u32(),
  inTransit: t.u32(),
  state: t.string(),
  stale: t.bool(),
  sourceVersion: t.u64(),
  liveSourceVersion: t.u64(),
  volunteerState: t.string(),
  declineReason: t.string(),
});

export const followUpRow = t.row('FollowUpRow', {
  followUpId: t.u64().primaryKey(),
  requestPk: t.u64(),
  reason: t.string(),
  state: t.string(),
  deadline: t.timestamp(),
  ownerLabel: t.string(),
});

export const estimateRow = t.row('EstimateRow', {
  estimateId: t.string().primaryKey(),
  shelterId: t.string(),
  resourceKind: t.string(),
  sampleSize: t.u32(),
  status: t.string(),
  low: t.u32(),
  high: t.u32(),
  label: t.string(),
});

export const shelterPolicyRow = t.row('ShelterPolicyRow', {
  shelterId: t.string().primaryKey(),
  name: t.string(),
  confirmWater: t.bool(),
  confirmCharging: t.bool(),
});

export const volunteerRow = t.row('VolunteerRow', {
  identity: t.identity().primaryKey(),
  label: t.string(),
  available: t.bool(),
  canCarryWater: t.bool(),
  chargerEscort: t.bool(),
  zone: t.string(),
  openTasks: t.u32(),
});

export const workerRequestRow = t.row('WorkerRequestRow', {
  requestPk: t.u64().primaryKey(),
  kind: t.string(),
  needs: t.string(),
  state: t.string(),
  quantity: t.u32(),
  receivedAt: t.timestamp(),
  humanPriority: t.u32(),
  stateVersion: t.u64(),
});

export const membershipRow = t.row('MembershipRow', {
  identity: t.identity().primaryKey(),
  shelterId: t.string(),
  role: t.string(),
  displayLabel: t.string(),
  active: t.bool(),
});

export const locationRow = t.row('LocationRow', {
  subjectKey: t.string().primaryKey(),
  subjectKind: t.string(),
  subjectId: t.u64(),
  lat: t.f64(),
  lon: t.f64(),
  accuracyM: t.f64(),
  receivedAt: t.timestamp(),
  source: t.string(),
  coarse: t.string(),
  sharing: t.bool(),
});

export const progressRow = t.row('ProgressRow', {
  requestPk: t.u64().primaryKey(),
  sentence: t.string(),
});

export const timelineRow = t.row('TimelineRow', {
  lineId: t.string().primaryKey(),
  at: t.timestamp(),
  kind: t.string(),
  subjectId: t.string(),
  summary: t.string(),
  requestKey: t.string(),
  transferKey: t.string(),
});

export const workerJobRow = t.row('WorkerJobRow', {
  jobId: t.u64().primaryKey(),
  shelterId: t.string(),
  state: t.string(),
  snapshotVersion: t.u64(),
  leaseExpiresAt: t.timestamp(),
  leaseOwner: t.identity(),
  fence: t.u64(),
});

export const workerOfferRow = t.row('WorkerOfferRow', {
  rowId: t.string().primaryKey(),
  kind: t.string(),
  destShelterId: t.string(),
  state: t.string(),
  quantity: t.u32(),
  offerCount: t.u32(),
});

export const workerVolunteerRow = t.row('WorkerVolunteerRow', {
  shelterId: t.string().primaryKey(),
  canCarryWater: t.u32(),
  chargerEscort: t.u32(),
});

export const autonomyState = table({name:'autonomy_state'}, {id:t.string().primaryKey(),json:t.string()});
export const autonomyConfig = table({name:'autonomy_config'}, {id:t.string().primaryKey(),gateway:t.string(),agent:t.string(),bootstrapAdmin:t.string()});
export const autonomyRow = t.row('AutonomyRow', {id:t.string().primaryKey(),json:t.string()});

const spacetimedb = schema(
  {
    shelter,
    autonomyState,
    autonomyConfig,
    member,
    moduleConfig,
    invite,
    helpRequest,
    resource,
    plan,
    planRequestPin,
    planResourcePin,
    planAssignment,
    planUnmatched,
    assignment,
    shelterVersion,
    event,
    modelRun,
    aiJob,
    aiJobEvent,
    aiJobLease,
    taskLocationLatest,
    approvalReceipt,
    volunteerProfile,
    actionReceipt,
    transfer,
    followUp,
    observation,
  },
  {
    env: {
      GATEWAY_IDENTITY: t.string().optional(),
      AGENT_IDENTITY: t.string().optional(),
      AUTONOMY_ADMIN_IDENTITY: t.string().optional(),
      AUTH_MODE: t.string().optional(),
      OIDC_ISSUER: t.string().optional(),
      OIDC_AUDIENCE: t.string().optional(),
      BOOTSTRAP_ADMIN_SUB: t.string().optional(),
      AI_MODE: t.string().optional(),
    },
  },
);

export default spacetimedb;
