import { seedAutonomy, executeAutonomy, gatewaySnapshot, agentSnapshot, userSnapshot, isService } from './autonomy';
import { autonomyRow } from './schema';
import { t } from 'spacetimedb/server';
import type { Ctx } from './logic';

function readCtx(ctx: unknown): Ctx {
  return ctx as Ctx;
}
import {
  assignFollowUp,
  cantReceive,
  confirmDelivery,
  coordinatorFollowUps,
  disputeDelivery,
  endChargingSession,
  flagFollowUp,
  sessionShelter,
  setServeBy,
  splitFulfillment,
} from './confirmation';
import { acceptTask, declineTask, flagOverdue, offerTask, reassignTask, reportCantDo, setVolunteerProfile, startTask } from './dispatch';
import { coordinatorEstimates } from './estimates';
import { coordinatorModelRuns, requestInvestigation } from './investigate';
import { acceptInvite, coordinatorInvites, createInvite } from './invites';
import {
  appendAiEvent,
  cancelAiJob,
  claimAiJob,
  coordinatorAiEvents,
  coordinatorAiJobs,
  finishAiJob,
  heartbeatAiJob,
  requestAiJob,
  workerAiJobs,
  workerTransferOffers,
  workerVolunteerCounts,
} from './jobs';
import { checkInTask, coordinatorLocations, coordinatorTimeline, myProgress, stopTaskLocation, updateTaskLocation } from './location';
import {
  acknowledgeRequest,
  applyPublishedEnv,
  approvePlan,
  assertSession,
  assignVolunteer,
  cancelRequest,
  claimDemoRole,
  completeAssignment,
  endClientSession,
  grantMembership,
  coordinatorBoard,
  coordinatorVolunteers,
  coordinatorPlanDetails,
  coordinatorPlans,
  coordinatorQueue,
  coordinatorResources,
  generatePlan,
  myAssignments,
  myMembership,
  myRequests,
  recentEvents,
  rejectPlan,
  rejectRequest,
  releaseAssignment,
  seedDemo,
  setHumanPriority,
  submitModelProposal,
  submitRequest,
  updateResource,
  workerRequests,
  workerResources,
} from './logic';
import spacetimedb, {
  assignmentRow,
  estimateRow,
  volunteerRow,
  aiJob,
  aiJobEvent,
  event,
  followUpRow,
  invite,
  locationRow,
  membershipRow,
  progressRow,
  timelineRow,
  workerJobRow,
  workerOfferRow,
  workerVolunteerRow,
  helpRequest,
  modelRun,
  plan,
  planDetailRow,
  queueRow,
  resource,
  shelterPolicyRow,
  transferRow,
  whatIfAdd,
  workerRequestRow,
} from './schema';
import {
  approveTransfer,
  cancelTransfer,
  collectTransfer,
  coordinatorTransfers,
  createShortage,
  myTransfers,
  offerTransfer,
  offerTransferTask,
  receiveTransfer,
  respondTransferTask,
} from './transfers';

export { default } from './schema';

export const init = spacetimedb.init(ctx => {
  seedDemo(ctx);
  applyPublishedEnv(ctx);
  seedAutonomy(ctx);
});

export const client_connected = spacetimedb.clientConnected(ctx => {
  if (!isService(readCtx(ctx))) assertSession(readCtx(ctx));
});

export const client_disconnected = spacetimedb.clientDisconnected(ctx => {
  endClientSession(readCtx(ctx));
});

export const claim_demo_role = spacetimedb.reducer(
  { shelterId: t.string(), role: t.string(), displayLabel: t.string() },
  (ctx, args) => {
    claimDemoRole(ctx, args.shelterId, args.role, args.displayLabel);
  },
);

export const submit_request = spacetimedb.reducer(
  {
    shelterId: t.string(),
    clientRequestId: t.string(),
    kind: t.string(),
    needs: t.array(t.string()),
    quantity: t.u32(),
    clientCreatedAt: t.string(),
  },
  (ctx, args) => {
    submitRequest(ctx, args);
  },
);

export const acknowledge_request = spacetimedb.reducer(
  { requestPk: t.u64(), expectedStateVersion: t.u64() },
  (ctx, { requestPk, expectedStateVersion }) => {
    acknowledgeRequest(ctx, requestPk, expectedStateVersion);
  },
);

export const set_human_priority = spacetimedb.reducer(
  { requestPk: t.u64(), level: t.u32(), reasonCode: t.string(), reason: t.string() },
  (ctx, { requestPk, level, reasonCode, reason }) => {
    setHumanPriority(ctx, requestPk, level, reasonCode, reason);
  },
);

export const update_resource = spacetimedb.reducer(
  {
    resourceId: t.string(),
    expectedVersion: t.u64(),
    capacityTotal: t.u32(),
    available: t.u32(),
  },
  (ctx, args) => {
    updateResource(
      ctx,
      args.resourceId,
      args.expectedVersion,
      args.capacityTotal,
      args.available,
    );
  },
);

export const generate_plan = spacetimedb.reducer(
  { shelterId: t.string(), strategy: t.string(), whatIf: t.array(whatIfAdd), policy: t.string() },
  (ctx, { shelterId, strategy, whatIf, policy }) => {
    generatePlan(ctx, shelterId, strategy, whatIf, policy);
  },
);

export const approve_plan = spacetimedb.reducer(
  { planId: t.u64(), expectedSnapshotVersion: t.u64(), approvalId: t.string() },
  (ctx, args) => {
    approvePlan(ctx, args.planId, args.expectedSnapshotVersion, args.approvalId);
  },
);

export const reject_plan = spacetimedb.reducer(
  { planId: t.u64(), reasonCode: t.string() },
  (ctx, { planId, reasonCode }) => {
    rejectPlan(ctx, planId, reasonCode);
  },
);

export const assign_volunteer = spacetimedb.reducer(
  { assignmentId: t.u64(), volunteerIdentity: t.identity() },
  (ctx, { assignmentId, volunteerIdentity }) => {
    assignVolunteer(ctx, assignmentId, volunteerIdentity);
  },
);

export const complete_assignment = spacetimedb.reducer(
  { assignmentId: t.u64() },
  (ctx, { assignmentId }) => {
    completeAssignment(ctx, assignmentId);
  },
);

export const release_assignment = spacetimedb.reducer(
  { assignmentId: t.u64(), reasonCode: t.string() },
  (ctx, { assignmentId, reasonCode }) => {
    releaseAssignment(ctx, assignmentId, reasonCode);
  },
);

export const cancel_request = spacetimedb.reducer(
  { requestPk: t.u64(), reasonCode: t.string() },
  (ctx, { requestPk, reasonCode }) => {
    cancelRequest(ctx, requestPk, reasonCode);
  },
);

export const reject_request = spacetimedb.reducer(
  { requestPk: t.u64(), reasonCode: t.string() },
  (ctx, { requestPk, reasonCode }) => {
    rejectRequest(ctx, requestPk, reasonCode);
  },
);

export const submit_model_proposal = spacetimedb.reducer(
  {
    runId: t.string(),
    planId: t.u64(),
    explanation: t.string(),
    toolTrace: t.string(),
    outcome: t.string(),
  },
  (ctx, args) => {
    submitModelProposal(
      ctx,
      args.runId,
      args.planId,
      args.explanation,
      args.toolTrace,
      args.outcome,
    );
  },
);

export const my_requests = spacetimedb.view(
  { name: 'my_requests', public: true },
  t.array(helpRequest.rowType),
  ctx => myRequests(readCtx(ctx)),
);

export const my_assignments = spacetimedb.view(
  { name: 'my_assignments', public: true },
  t.array(assignmentRow),
  ctx => myAssignments(readCtx(ctx)),
);

export const coordinator_queue = spacetimedb.view(
  { name: 'coordinator_queue', public: true },
  t.array(queueRow),
  ctx => coordinatorQueue(readCtx(ctx)),
);

export const coordinator_resources = spacetimedb.view(
  { name: 'coordinator_resources', public: true },
  t.array(resource.rowType),
  ctx => coordinatorResources(readCtx(ctx)),
);

export const coordinator_plans = spacetimedb.view(
  { name: 'coordinator_plans', public: true },
  t.array(plan.rowType),
  ctx => coordinatorPlans(readCtx(ctx)),
);

export const coordinator_plan_details = spacetimedb.view(
  { name: 'coordinator_plan_details', public: true },
  t.array(planDetailRow),
  ctx => coordinatorPlanDetails(readCtx(ctx)),
);

export const recent_events = spacetimedb.view(
  { name: 'recent_events', public: true },
  t.array(event.rowType),
  ctx => recentEvents(readCtx(ctx)),
);

export const worker_requests = spacetimedb.view(
  { name: 'worker_requests', public: true },
  t.array(workerRequestRow),
  ctx => workerRequests(readCtx(ctx)),
);

export const worker_resources = spacetimedb.view(
  { name: 'worker_resources', public: true },
  t.array(resource.rowType),
  ctx => workerResources(readCtx(ctx)),
);

export const coordinator_volunteers = spacetimedb.view(
  { name: 'coordinator_volunteers', public: true },
  t.array(volunteerRow),
  ctx => coordinatorVolunteers(readCtx(ctx)),
);

export const coordinator_board = spacetimedb.view(
  { name: 'coordinator_board', public: true },
  t.array(assignmentRow),
  ctx => coordinatorBoard(readCtx(ctx)),
);

export const coordinator_transfers = spacetimedb.view(
  { name: 'coordinator_transfers', public: true },
  t.array(transferRow),
  ctx => coordinatorTransfers(readCtx(ctx)),
);

export const my_transfers = spacetimedb.view(
  { name: 'my_transfers', public: true },
  t.array(transferRow),
  ctx => myTransfers(readCtx(ctx)),
);

export const coordinator_follow_ups = spacetimedb.view(
  { name: 'coordinator_follow_ups', public: true },
  t.array(followUpRow),
  ctx => coordinatorFollowUps(readCtx(ctx)),
);

export const coordinator_estimates = spacetimedb.view(
  { name: 'coordinator_estimates', public: true },
  t.array(estimateRow),
  ctx => coordinatorEstimates(readCtx(ctx)),
);

export const session_shelter = spacetimedb.view(
  { name: 'session_shelter', public: true },
  t.array(shelterPolicyRow),
  ctx => sessionShelter(readCtx(ctx)),
);

export const coordinator_model_runs = spacetimedb.view(
  { name: 'coordinator_model_runs', public: true },
  t.array(modelRun.rowType),
  ctx => coordinatorModelRuns(readCtx(ctx)),
);

export const offer_task = spacetimedb.reducer(
  { assignmentId: t.u64(), volunteerIdentity: t.identity(), dueAtMicros: t.u64(), actionId: t.string() },
  (ctx, args) => offerTask(ctx, args.assignmentId, args.volunteerIdentity, args.dueAtMicros, args.actionId),
);

export const accept_task = spacetimedb.reducer(
  { assignmentId: t.u64(), expectedVersion: t.u64(), actionId: t.string() },
  (ctx, args) => acceptTask(ctx, args.assignmentId, args.expectedVersion, args.actionId),
);

export const decline_task = spacetimedb.reducer(
  { assignmentId: t.u64(), reason: t.string(), actionId: t.string() },
  (ctx, args) => declineTask(ctx, args.assignmentId, args.reason, args.actionId),
);

export const start_task = spacetimedb.reducer(
  { assignmentId: t.u64(), actionId: t.string() },
  (ctx, args) => startTask(ctx, args.assignmentId, args.actionId),
);

export const report_cant_do = spacetimedb.reducer(
  { assignmentId: t.u64(), reason: t.string(), actionId: t.string() },
  (ctx, args) => reportCantDo(ctx, args.assignmentId, args.reason, args.actionId),
);

export const flag_overdue = spacetimedb.reducer(
  { assignmentId: t.u64(), actionId: t.string() },
  (ctx, args) => flagOverdue(ctx, args.assignmentId, args.actionId),
);

export const reassign_task = spacetimedb.reducer(
  {
    assignmentId: t.u64(),
    volunteerIdentity: t.identity(),
    expectedVersion: t.u64(),
    reason: t.string(),
    actionId: t.string(),
  },
  (ctx, args) => reassignTask(ctx, args.assignmentId, args.volunteerIdentity, args.expectedVersion, args.reason, args.actionId),
);

export const set_volunteer_profile = spacetimedb.reducer(
  {
    identity: t.identity(),
    available: t.bool(),
    canCarryWater: t.bool(),
    chargerEscort: t.bool(),
    zone: t.string(),
  },
  (ctx, args) => setVolunteerProfile(ctx, args.identity, args.available, args.canCarryWater, args.chargerEscort, args.zone),
);

export const create_shortage = spacetimedb.reducer(
  { kind: t.string(), quantity: t.u32(), actionId: t.string() },
  (ctx, args) => createShortage(ctx, args.kind, args.quantity, args.actionId),
);

export const offer_transfer = spacetimedb.reducer(
  { transferId: t.u64(), resourceId: t.string(), quantity: t.u32(), actionId: t.string() },
  (ctx, args) => offerTransfer(ctx, args.transferId, args.resourceId, args.quantity, args.actionId),
);

export const approve_transfer = spacetimedb.reducer(
  { transferId: t.u64(), actionId: t.string() },
  (ctx, args) => approveTransfer(ctx, args.transferId, args.actionId),
);

export const offer_transfer_task = spacetimedb.reducer(
  { transferId: t.u64(), volunteerIdentity: t.identity(), actionId: t.string() },
  (ctx, args) => offerTransferTask(ctx, args.transferId, args.volunteerIdentity, args.actionId),
);

export const respond_transfer_task = spacetimedb.reducer(
  { transferId: t.u64(), accept: t.bool(), reason: t.string(), actionId: t.string() },
  (ctx, args) => respondTransferTask(ctx, args.transferId, args.accept, args.reason, args.actionId),
);

export const collect_transfer = spacetimedb.reducer(
  { transferId: t.u64(), actionId: t.string() },
  (ctx, args) => collectTransfer(ctx, args.transferId, args.actionId),
);

export const cancel_transfer = spacetimedb.reducer(
  { transferId: t.u64(), actionId: t.string() },
  (ctx, args) => cancelTransfer(ctx, args.transferId, args.actionId),
);

export const receive_transfer = spacetimedb.reducer(
  { transferId: t.u64(), count: t.u32(), receiptId: t.string() },
  (ctx, args) => receiveTransfer(ctx, args.transferId, args.count, args.receiptId),
);

export const confirm_delivery = spacetimedb.reducer(
  { requestPk: t.u64(), actionId: t.string() },
  (ctx, args) => confirmDelivery(ctx, args.requestPk, args.actionId),
);

export const dispute_delivery = spacetimedb.reducer(
  { requestPk: t.u64(), actionId: t.string() },
  (ctx, args) => disputeDelivery(ctx, args.requestPk, args.actionId),
);

export const cant_receive = spacetimedb.reducer(
  { requestPk: t.u64(), actionId: t.string() },
  (ctx, args) => cantReceive(ctx, args.requestPk, args.actionId),
);

export const end_charging_session = spacetimedb.reducer(
  { assignmentId: t.u64(), actionId: t.string() },
  (ctx, args) => endChargingSession(ctx, args.assignmentId, args.actionId),
);

export const assign_follow_up = spacetimedb.reducer(
  { followUpId: t.u64(), deadlineMicros: t.u64(), actionId: t.string() },
  (ctx, args) => assignFollowUp(ctx, args.followUpId, args.deadlineMicros, args.actionId),
);

export const flag_follow_up = spacetimedb.reducer(
  { followUpId: t.u64(), actionId: t.string() },
  (ctx, args) => flagFollowUp(ctx, args.followUpId, args.actionId),
);

export const set_serve_by = spacetimedb.reducer(
  { requestPk: t.u64(), deadlineMicros: t.u64() },
  (ctx, args) => setServeBy(ctx, args.requestPk, args.deadlineMicros),
);

export const split_fulfillment = spacetimedb.reducer(
  { requestPk: t.u64(), units: t.u32(), actionId: t.string() },
  (ctx, args) => splitFulfillment(ctx, args.requestPk, args.units, args.actionId),
);

export const request_investigation = spacetimedb.reducer(
  { shelterId: t.string(), runId: t.string() },
  (ctx, args) => requestInvestigation(ctx, args.shelterId, args.runId),
);

export const grant_membership = spacetimedb.reducer(
  { identity: t.identity(), shelterId: t.string(), role: t.string(), displayLabel: t.string() },
  (ctx, args) => grantMembership(ctx, args.identity, args.shelterId, args.role, args.displayLabel),
);

export const create_invite = spacetimedb.reducer(
  {
    inviteId: t.string(),
    shelterId: t.string(),
    role: t.string(),
    taskId: t.string(),
    expiresAtMicros: t.u64(),
    maxUses: t.u32(),
  },
  (ctx, args) => createInvite(ctx, args.inviteId, args.shelterId, args.role, args.taskId, args.expiresAtMicros, args.maxUses),
);

export const accept_invite = spacetimedb.reducer(
  { inviteId: t.string() },
  (ctx, args) => acceptInvite(ctx, args.inviteId),
);

export const request_ai_job = spacetimedb.reducer(
  { shelterId: t.string(), jobClientId: t.string() },
  (ctx, args) => requestAiJob(ctx, args.shelterId, args.jobClientId),
);

export const claim_ai_job = spacetimedb.reducer(
  { jobId: t.u64() },
  (ctx, args) => claimAiJob(ctx, args.jobId),
);

export const heartbeat_ai_job = spacetimedb.reducer(
  { jobId: t.u64(), fence: t.u64() },
  (ctx, args) => heartbeatAiJob(ctx, args.jobId, args.fence),
);

export const append_ai_event = spacetimedb.reducer(
  {
    jobId: t.u64(),
    fence: t.u64(),
    seq: t.u32(),
    toolName: t.string(),
    inputSummary: t.string(),
    resultRef: t.string(),
    resultSummary: t.string(),
    live: t.bool(),
  },
  (ctx, args) =>
    appendAiEvent(ctx, args.jobId, args.fence, args.seq, args.toolName, args.inputSummary, args.resultRef, args.resultSummary, args.live),
);

export const finish_ai_job = spacetimedb.reducer(
  { jobId: t.u64(), fence: t.u64(), outcome: t.string(), explanation: t.string(), live: t.bool() },
  (ctx, args) => finishAiJob(ctx, args.jobId, args.fence, args.outcome, args.explanation, args.live),
);

export const cancel_ai_job = spacetimedb.reducer(
  { jobId: t.u64() },
  (ctx, args) => cancelAiJob(ctx, args.jobId),
);

export const update_task_location = spacetimedb.reducer(
  {
    assignmentId: t.u64(),
    transferId: t.u64(),
    seq: t.u64(),
    lat: t.f64(),
    lon: t.f64(),
    accuracyM: t.f64(),
    capturedAt: t.string(),
  },
  (ctx, args) =>
    updateTaskLocation(ctx, args.assignmentId, args.transferId, args.seq, args.lat, args.lon, args.accuracyM, args.capturedAt),
);

export const stop_task_location = spacetimedb.reducer(
  { assignmentId: t.u64(), transferId: t.u64() },
  (ctx, args) => stopTaskLocation(ctx, args.assignmentId, args.transferId),
);

export const check_in_task = spacetimedb.reducer(
  { assignmentId: t.u64(), transferId: t.u64(), stage: t.string() },
  (ctx, args) => checkInTask(ctx, args.assignmentId, args.transferId, args.stage),
);

export const my_membership = spacetimedb.view(
  { name: 'my_membership', public: true },
  t.array(membershipRow),
  ctx => myMembership(readCtx(ctx)),
);

export const coordinator_invites = spacetimedb.view(
  { name: 'coordinator_invites', public: true },
  t.array(invite.rowType),
  ctx => coordinatorInvites(readCtx(ctx)),
);

export const coordinator_ai_jobs = spacetimedb.view(
  { name: 'coordinator_ai_jobs', public: true },
  t.array(aiJob.rowType),
  ctx => coordinatorAiJobs(readCtx(ctx)),
);

export const coordinator_ai_events = spacetimedb.view(
  { name: 'coordinator_ai_events', public: true },
  t.array(aiJobEvent.rowType),
  ctx => coordinatorAiEvents(readCtx(ctx)),
);

export const worker_ai_jobs = spacetimedb.view(
  { name: 'worker_ai_jobs', public: true },
  t.array(workerJobRow),
  ctx => workerAiJobs(readCtx(ctx)),
);

export const worker_transfer_offers = spacetimedb.view(
  { name: 'worker_transfer_offers', public: true },
  t.array(workerOfferRow),
  ctx => workerTransferOffers(readCtx(ctx)),
);

export const worker_volunteer_counts = spacetimedb.view(
  { name: 'worker_volunteer_counts', public: true },
  t.array(workerVolunteerRow),
  ctx => workerVolunteerCounts(readCtx(ctx)),
);

export const coordinator_locations = spacetimedb.view(
  { name: 'coordinator_locations', public: true },
  t.array(locationRow),
  ctx => coordinatorLocations(readCtx(ctx)),
);

export const my_progress = spacetimedb.view(
  { name: 'my_progress', public: true },
  t.array(progressRow),
  ctx => myProgress(readCtx(ctx)),
);

export const coordinator_timeline = spacetimedb.view(
  { name: 'coordinator_timeline', public: true },
  t.array(timelineRow),
  ctx => coordinatorTimeline(readCtx(ctx)),
);

export const autonomy_command = spacetimedb.reducer(
  { actorJson:t.string(), commandJson:t.string() },
  (ctx,args)=>executeAutonomy(ctx,args.actorJson,args.commandJson),
);
export const gateway_state = spacetimedb.view({name:'gateway_state',public:true},t.array(autonomyRow),ctx=>gatewaySnapshot(ctx));
export const agent_work = spacetimedb.view({name:'agent_work',public:true},t.array(autonomyRow),ctx=>agentSnapshot(ctx));
export const my_cases = spacetimedb.view({name:'my_cases',public:true},t.array(autonomyRow),ctx=>userSnapshot(ctx));
