/** Serializable contracts shared by Spacetime, gateway, workers and browser. */
export const CATEGORIES = ['medical','fire','flood','rescue','safety','utility','vehicle','water','charging','food','shelter','other'] as const;
export type Category = typeof CATEGORIES[number];
export const CONSENTS = ['precise_location','foreground_location','microphone','camera','vision','callbacks'] as const;
export type ConsentType = typeof CONSENTS[number];
export type Role = 'resident'|'volunteer'|'coordinator'|'agency'|'admin';
export type Actor = { id:string; kind:'user'|'agent'|'gateway'|'sandbox'; verified?:boolean; role?:Role; orgId?:string };
export type Location = { lat?:number; lon?:number; accuracyM?:number; capturedAt:number; source:'gps'|'manual'|'landmark'; label:string; confirmed:boolean };
export type Profile = { id:string; role:Role; orgId:string; label:string; language:'en'|'es'; verified:boolean; active:boolean; guest:boolean; expiresAt:number; signedOn:boolean; skills:string[]; skillsVerified:boolean; capabilityHash?:string; serviceMinutes?:number };
export type CaseState = 'intake'|'needs_info'|'routing'|'awaiting_service'|'accepted'|'active_assistance'|'partially_resolved'|'resolved'|'cancel_requested'|'cancelled'|'unable_to_contact'|'escalation_needed';
export type Case = { id:string; ownerId:string; conversationId:string; kind:'resource'|'incident'; category:Category; text:string; originalText:string; language:string; danger:'yes'|'no'|'unsure'; priority:'routine'|'urgent_unverified'; quantity:number; accessible:boolean; chargerKnown:boolean; confirmed:boolean; affectedPerson:string; location:Location|null; shelterId:string; state:CaseState; version:number; createdAt:number; updatedAt:number; closedAt:number; requestPk:string; requestState:string; assignmentId:string; referralId:string; missing:string[]; followUp:{owner:string;dueAt:number;reason:string}|null };
export type Consent = { ownerId:string; caseId:string; type:ConsentType; granted:boolean; at:number; version:number };
export type Event = { id:string; caseId:string; actorId:string; actorKind:string; type:string; at:number; ruleId:string; evidenceIds:string[]; summary:string };
export type Stock = { id:string; shelterId:string; kind:'water'|'charging'; accessible:boolean; available:number; reserved:number; version:number };
export type Task = { id:string; caseId:string; volunteerId:string; stockId:string; units:number; state:'offered'|'accepted'|'started'|'delivered'|'declined'|'failed'|'released'; version:number; offeredAt:number; dueAt:number; consumed:boolean; chargingEnded:boolean };
export type Transfer = { id:string; caseId:string; fromShelter:string; toShelter:string; kind:'water'|'charging'; offered:number; held:number; inTransit:number; received:number; lost:number; state:'proposed'|'received'|'cancelled'; version:number };
export type Service = { id:string; name:string; orgId:string; categories:Category[]; polygon:[number,number][]; available:boolean; capacity:number; autoAccept:boolean; mode:'normal'|'busy'|'reject'|'no_ack'|'duplicate'|'out_of_order'; delayMs:number };
export type Referral = { id:string; caseId:string; serviceId:string; state:'queued'|'sent'|'acked'|'accepted'|'declined'|'busy'|'dispatched'|'en_route'|'arrived'|'resolved'|'unable_to_locate'|'no_response'|'unconfirmed'; seq:number; attempts:number; nextAt:number; sentAt:number; acceptedAt:number; retired:boolean; version:number };
export type Callback = { id:string; caseId:string; ownerId:string; triggerId:string; state:'scheduled'|'ringing'|'accepted'|'declined'|'message'|'done'|'cancelled'; attempts:number; nextAt:number; deviceId:string; leaseUntil:number; callId:string };
export type Call = { id:string; caseId:string; ownerId:string; roomId:string; state:'connecting'|'ringing'|'active_ai'|'reconnecting'|'ended'|'failed'; deviceId:string; createdAt:number; expiresAt:number; participants:string[]; transcript:{role:string;text:string;at:number}[] };
export type Job = { id:string; caseId:string; kind:string; caseVersion:number; state:'queued'|'running'|'done'|'failed'; owner:string; leaseUntil:number; fence:number; attempts:number; nextAt:number; error:string };
export type Policy = { version:number; autonomy:boolean; locationStaleMs:number; maxAccuracyM:number; callbackAttempts:number; callbackCooldownMs:number; leaseMs:number; transcriptTtlMs:number; locationTtlMs:number; caseTtlMs:number; autoTransfer:Record<string,boolean> };
export type State = { schemaVersion:1; revision:number; profiles:Record<string,Profile>; cases:Record<string,Case>; consents:Record<string,Consent>; events:Event[]; stock:Record<string,Stock>; tasks:Record<string,Task>; transfers:Record<string,Transfer>; services:Record<string,Service>; referrals:Record<string,Referral>; callbacks:Record<string,Callback>; calls:Record<string,Call>; jobs:Record<string,Job>; receipts:Record<string,{fingerprint:string;result:unknown}>; policy:Policy; messages:{id:string;ownerId:string;caseId:string;text:string;at:number}[] };
export type Command = { name:string; operationId:string; expectedVersion?:number; caseId?:string; body:Record<string,unknown> };
export type View = { profile:Profile; cases:Case[]; consents:Consent[]; events:Event[]; tasks:Task[]; transfers:Transfer[]; referrals:Referral[]; callbacks:Callback[]; calls:Call[]; stock:Stock[]; services:Service[]; messages:State['messages']; policy?:Policy; revision:number; profiles?:Profile[] };
export function initialState():State { return {schemaVersion:1,revision:0,profiles:{},cases:{},consents:{},events:[],stock:{},tasks:{},transfers:{},services:{},referrals:{},callbacks:{},calls:{},jobs:{},receipts:{},messages:[],policy:{version:1,autonomy:true,locationStaleMs:300_000,maxAccuracyM:100,callbackAttempts:2,callbackCooldownMs:600_000,leaseMs:20_000,transcriptTtlMs:86_400_000,locationTtlMs:604_800_000,caseTtlMs:2_592_000_000,autoTransfer:{'shelter-a':false,'shelter-b':false}}}; }
/** Fills fields added after a state file was saved. Idempotent. */
export function hydrate(state: State): State {
  if (!state.transfers) state.transfers = {};
  if (!state.messages) state.messages = [];
  if (!state.policy) state.policy = initialState().policy;
  if (!state.policy.autoTransfer) state.policy.autoTransfer = { 'shelter-a': false, 'shelter-b': false };
  for (const item of Object.values(state.cases || {})) {
    if (typeof item.chargerKnown !== 'boolean') item.chargerKnown = item.category !== 'charging';
  }
  for (const person of Object.values(state.profiles || {})) {
    if (person.serviceMinutes === undefined) person.serviceMinutes = 0;
  }
  return state;
}
