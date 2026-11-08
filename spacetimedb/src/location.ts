import { Identity } from 'spacetimedb';
import { fail, logEvent, requireMember, type Ctx } from './logic';

const STAGES = new Set(['picked_up', 'on_the_way', 'arrived']);
const ACTIVE = new Set(['accepted', 'in_progress']);
const RATE_MICROS = 5_000_000n;

function finiteIn(value: number, low: number, high: number) {
  return Number.isFinite(value) && value >= low && value <= high;
}

function assignmentSubject(ctx: Ctx, assignmentId: bigint) {
  const row = ctx.db.assignment.assignmentId.find(assignmentId);
  if (!row) fail('NOT_FOUND');
  if (!row.volunteerSet || !row.volunteerIdentity.equals(ctx.sender)) fail('UNAUTHORIZED');
  if (!ACTIVE.has(row.dispatchState)) fail('INVALID_TRANSITION');
  requireMember(ctx, row.shelterId, ['volunteer']);
  return { subjectKey: `a:${assignmentId}`, shelterId: row.shelterId, partnerShelterId: '', subjectKind: 'assignment', subjectId: assignmentId };
}

function transferSubject(ctx: Ctx, transferId: bigint) {
  const row = ctx.db.transfer.transferId.find(transferId);
  if (!row) fail('NOT_FOUND');
  if (!row.responsibleSet || !row.responsibleVolunteer.equals(ctx.sender)) fail('UNAUTHORIZED');
  if (row.volunteerState !== 'accepted' && row.state !== 'in_transit') fail('INVALID_TRANSITION');
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || !member.active || member.role !== 'volunteer') fail('UNAUTHORIZED');
  if (member.shelterId !== row.sourceShelterId && member.shelterId !== row.destShelterId) fail('WRONG_SHELTER');
  return {
    subjectKey: `t:${transferId}`,
    shelterId: row.sourceShelterId,
    partnerShelterId: row.destShelterId,
    subjectKind: 'transfer',
    subjectId: transferId,
  };
}

function subjectFor(ctx: Ctx, assignmentId: bigint, transferId: bigint) {
  if (assignmentId > 0n && transferId === 0n) return assignmentSubject(ctx, assignmentId);
  if (transferId > 0n && assignmentId === 0n) return transferSubject(ctx, transferId);
  fail('INVALID_INPUT');
}

export function updateTaskLocation(
  ctx: Ctx,
  assignmentId: bigint,
  transferId: bigint,
  seq: bigint,
  lat: number,
  lon: number,
  accuracyM: number,
  capturedAt: string,
) {
  const subject = subjectFor(ctx, assignmentId, transferId);
  if (!finiteIn(lat, -90, 90) || !finiteIn(lon, -180, 180) || !Number.isFinite(accuracyM) || accuracyM <= 0) {
    fail('INVALID_INPUT');
  }
  if (capturedAt.length > 40 || seq <= 0n) fail('INVALID_INPUT');
  const existing = ctx.db.taskLocationLatest.subjectKey.find(subject.subjectKey);
  if (existing?.source === 'stopped') fail('INVALID_TRANSITION');
  if (existing) {
    if (seq <= existing.seq) fail('INVALID_INPUT');
    if (ctx.timestamp.microsSinceUnixEpoch - existing.receivedAt.microsSinceUnixEpoch < RATE_MICROS) fail('RATE_LIMIT');
  }
  const next = {
    subjectKey: subject.subjectKey,
    shelterId: subject.shelterId,
    partnerShelterId: subject.partnerShelterId,
    subjectKind: subject.subjectKind,
    subjectId: subject.subjectId,
    volunteerIdentity: ctx.sender,
    seq,
    lat,
    lon,
    accuracyM,
    capturedAt,
    receivedAt: ctx.timestamp,
    sharing: true,
    coarse: existing?.coarse || 'on_the_way',
    source: 'gps',
  };
  if (existing) ctx.db.taskLocationLatest.subjectKey.update(next);
  else ctx.db.taskLocationLatest.insert(next);
  if (!existing || !existing.sharing) {
    logEvent(ctx, subject.shelterId, 'location_sharing_started', subject.subjectKey, '', '');
  }
}

export function stopTaskLocation(ctx: Ctx, assignmentId: bigint, transferId: bigint) {
  const subject = subjectFor(ctx, assignmentId, transferId);
  const existing = ctx.db.taskLocationLatest.subjectKey.find(subject.subjectKey);
  if (!existing || existing.source === 'stopped') return;
  ctx.db.taskLocationLatest.subjectKey.update({
    ...existing,
    sharing: false,
    lat: 0,
    lon: 0,
    accuracyM: 0,
    source: 'stopped',
    coarse: '',
    receivedAt: ctx.timestamp,
  });
  logEvent(ctx, subject.shelterId, 'location_sharing_stopped', subject.subjectKey, '', '');
}

export function checkInTask(ctx: Ctx, assignmentId: bigint, transferId: bigint, stage: string) {
  const subject = subjectFor(ctx, assignmentId, transferId);
  if (!STAGES.has(stage)) fail('INVALID_INPUT');
  const existing = ctx.db.taskLocationLatest.subjectKey.find(subject.subjectKey);
  const next = {
    subjectKey: subject.subjectKey,
    shelterId: subject.shelterId,
    partnerShelterId: subject.partnerShelterId,
    subjectKind: subject.subjectKind,
    subjectId: subject.subjectId,
    volunteerIdentity: ctx.sender,
    seq: existing?.seq ?? 0n,
    lat: existing?.source === 'gps' ? existing.lat : 0,
    lon: existing?.source === 'gps' ? existing.lon : 0,
    accuracyM: existing?.source === 'gps' ? existing.accuracyM : 0,
    capturedAt: '',
    receivedAt: ctx.timestamp,
    sharing: existing?.sharing ?? false,
    coarse: stage,
    source: existing?.sharing ? 'gps' : 'user',
  };
  if (existing) ctx.db.taskLocationLatest.subjectKey.update(next);
  else ctx.db.taskLocationLatest.insert(next);
  logEvent(ctx, subject.shelterId, 'task_check_in', subject.subjectKey, '', stage);
}

function visible(memberShelter: string, row: { shelterId: string; partnerShelterId: string }) {
  return row.shelterId === memberShelter || (row.partnerShelterId !== '' && row.partnerShelterId === memberShelter);
}

export function coordinatorLocations(ctx: { db: Ctx['db']; sender: Identity }) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || member.role !== 'coordinator' || !member.active) return [];
  return [...ctx.db.taskLocationLatest.iter()]
    .filter(row => visible(member.shelterId, row) && row.source !== 'stopped')
    .map(row => ({
      subjectKey: row.subjectKey,
      subjectKind: row.subjectKind,
      subjectId: row.subjectId,
      lat: row.source === 'gps' && row.sharing ? row.lat : 0,
      lon: row.source === 'gps' && row.sharing ? row.lon : 0,
      accuracyM: row.source === 'gps' && row.sharing ? row.accuracyM : 0,
      receivedAt: row.receivedAt,
      source: row.source,
      coarse: row.coarse,
      sharing: row.sharing,
    }));
}

function progressSentence(coarse: string, sharing: boolean) {
  if (coarse === 'arrived') return 'Arrived';
  if (coarse === 'on_the_way' || coarse === 'picked_up' || sharing) return 'Volunteer is on the way';
  return '';
}

export function myProgress(ctx: { db: Ctx['db']; sender: Identity }) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || member.role !== 'resident' || !member.active) return [];
  const mine = [...ctx.db.helpRequest.iter()].filter(request => request.residentIdentity.equals(ctx.sender));
  const rows: { requestPk: bigint; sentence: string }[] = [];
  for (const request of mine) {
    const assignment = [...ctx.db.assignment.iter()].find(item => item.requestPk === request.requestPk);
    if (!assignment) continue;
    const point = ctx.db.taskLocationLatest.subjectKey.find(`a:${assignment.assignmentId}`);
    const sentence = point ? progressSentence(point.coarse, point.sharing) : '';
    if (!sentence) continue;
    rows.push({ requestPk: request.requestPk, sentence });
  }
  return rows;
}

function timelineSummary(type: string, details: string) {
  if (type === 'location_sharing_started') return 'Location sharing started';
  if (type === 'location_sharing_stopped') return 'Location sharing stopped';
  if (type === 'task_check_in') return `Check-in ${details} (user-entered)`;
  return details ? `${type} ${details}` : type;
}

function requestKey(type: string, subjectId: string) {
  if (type.includes('transfer')) return '';
  if (type.includes('request') || type.startsWith('resident') || type === 'priority_set' || type === 'serve_by_set') return subjectId;
  return '';
}

export function coordinatorTimeline(ctx: { db: Ctx['db']; sender: Identity }) {
  const member = ctx.db.member.identity.find(ctx.sender);
  if (!member || member.role !== 'coordinator' || !member.active) return [];
  const desk = [...ctx.db.event.iter()]
    .filter(item => item.shelterId === member.shelterId)
    .map(item => ({
      lineId: `event:${item.eventId}`,
      at: item.at,
      kind: item.type,
      subjectId: item.subjectId,
      summary: timelineSummary(item.type, item.type.startsWith('location_') ? '' : item.details),
      requestKey: requestKey(item.type, item.subjectId),
      transferKey: item.type.includes('transfer') || item.type === 'shortage_requested' ? item.subjectId : '',
    }));
  const jobs = [...ctx.db.aiJobEvent.iter()]
    .filter(item => item.shelterId === member.shelterId)
    .map(item => ({
      lineId: `ai:${item.eventId}`,
      at: item.at,
      kind: item.toolName,
      subjectId: item.jobId.toString(),
      summary: `${item.toolName} ${item.resultRef}`.trim(),
      requestKey: '',
      transferKey: '',
    }));
  return [...desk, ...jobs]
    .sort((a, b) => (a.at.microsSinceUnixEpoch < b.at.microsSinceUnixEpoch ? -1 : a.at.microsSinceUnixEpoch > b.at.microsSinceUnixEpoch ? 1 : 0))
    .slice(-200);
}
