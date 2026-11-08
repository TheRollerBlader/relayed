import {deliverReferrals} from './referrals.ts';
import {createServer} from 'node:http';
import {randomBytes,randomUUID} from 'node:crypto';
import {Database} from '../db.ts';
import {json,rawBody,verify,safeError} from '../http.ts';
import {authenticate,digest,equal,outboxKey} from './auth.ts';
import {extractIntake,analyzeFrame} from './model.ts';
import {viewFor,consent} from '../../shared/autonomy/engine.ts';
import type {Actor,Command} from '../../shared/autonomy/contracts.ts';
import {AccessToken,RoomServiceClient,AgentDispatchClient} from 'livekit-server-sdk';
const db=new Database('GATEWAY');
const referralTimer=deliverReferrals(db);
const origin=process.env.APP_ORIGIN||'http://localhost:5173';
const internalLivekit=process.env.LIVEKIT_INTERNAL_URL||process.env.LIVEKIT_URL||'ws://127.0.0.1:7880';
const rooms=new RoomServiceClient(internalLivekit.replace(/^ws/,'http'),process.env.LIVEKIT_API_KEY,process.env.LIVEKIT_API_SECRET);
const dispatch=new AgentDispatchClient(internalLivekit.replace(/^ws/,'http'),process.env.LIVEKIT_API_KEY,process.env.LIVEKIT_API_SECRET);
const allowed=new Set(['create_case','set_consent','update_case','volunteer_action','confirm_delivery','dispute_delivery','cancel_case','claim_callback','start_call','answer_call','end_call','decline_call','set_availability','admin_grant','admin_service','admin_policy','delete_account']);
const frames=new Map<string,{at:number;controller:AbortController}>();
const counters={requests:0,rejected:0,modelFallbacks:0};
const server=createServer(async(req,res)=>{
  counters.requests++;
  res.setHeader('Vary','Origin');
  if(req.headers.origin===origin){res.setHeader('access-control-allow-origin',origin);res.setHeader('access-control-allow-headers','Authorization, Content-Type, X-Guest-Capability');res.setHeader('access-control-allow-methods','GET, POST, OPTIONS')}
  if(req.method==='OPTIONS'){res.writeHead(204);res.end();return}
  if(req.headers.origin&&req.headers.origin!==origin){json(res,403,{error:'UNAUTHORIZED'});return}
  const url=new URL(req.url||'/','http://localhost');
  try {
    if(url.pathname==='/health'){await db.connect();json(res,200,{ok:true,service:'gateway',...counters});return}
    const state=await db.snapshot();
    if(url.pathname==='/callbacks/referral-events'&&req.method==='POST'){
      const body=await rawBody(req),timestamp=String(req.headers['x-relay-timestamp']||''),signature=String(req.headers['x-relay-signature']||'');
      if(!verify(body,timestamp,signature,process.env.REFERRAL_SECRET!))throw new Error('UNAUTHORIZED');
      const input=JSON.parse(body);const referral=state.referrals[input.referralId];if(!referral||state.services[referral.serviceId]?.orgId!==input.orgId)throw new Error('UNAUTHORIZED');
      await db.command({id:input.orgId,kind:'sandbox'},{name:'referral_event',operationId:`sandbox-${input.referralId}-${input.seq}`,expectedVersion:referral.version,body:{referralId:input.referralId,seq:input.seq,state:input.state}});json(res,200,{ok:true});return;
    }
    if(url.pathname==='/api/guest'&&req.method==='POST'){
      const id=randomBytes(32).toString('hex'),secret=randomBytes(32).toString('base64url');
      const actor:Actor={id,kind:'user',verified:false};
      await db.command(actor,{name:'register',operationId:randomUUID(),expectedVersion:0,body:{label:'Guest',capabilityHash:digest(secret)}});
      json(res,201,{capability:`guest.${id}.${secret}`,expiresAt:Date.now()+86400000});return;
    }
    if(url.pathname.startsWith('/internal/media/')){
      if(!equal(String(req.headers.authorization||''),'Bearer '+process.env.MEDIA_AGENT_SECRET))throw new Error('UNAUTHORIZED');
      const input=req.method==='POST'?JSON.parse(await rawBody(req)):Object.fromEntries(url.searchParams);const call=state.calls[input.callId];
      if(!call||!['connecting','active_ai','reconnecting'].includes(call.state)||call.expiresAt<=Date.now())throw new Error('UNAUTHORIZED');
      const c=state.cases[call.caseId];if(!c||!state.profiles[call.ownerId]?.active)throw new Error('UNAUTHORIZED');
      if(url.pathname.endsWith('/context')){json(res,200,{call,case:c,consents:{microphone:consent(state,c,'microphone'),camera:consent(state,c,'camera'),vision:consent(state,c,'vision')},status:`Case ${c.state}; request ${c.requestState}. ${c.followUp?.reason||''}`,recording:false});return}
      if(url.pathname.endsWith('/transcript')){await db.command({id:'media',kind:'agent'},{name:'transcript',operationId:randomUUID(),body:{callId:call.id,role:input.role,text:input.text}});json(res,200,{ok:true});return}
      if(url.pathname.endsWith('/draft')){json(res,200,await extractIntake(String(input.text).slice(0,2000),c.language));return}
      throw new Error('UNKNOWN_COMMAND');
    }
    const actor=await authenticate(req,state);
    if(!state.profiles[actor.id])await db.command(actor,{name:'register',operationId:randomUUID(),expectedVersion:0,body:{label:'Resident'}});
    if(url.pathname==='/api/session'||url.pathname==='/api/state'){json(res,200,viewFor(await db.snapshot(),actor));return}
    if(url.pathname==='/api/outbox-key'){json(res,200,{ownerIdentity:actor.id,key:outboxKey(actor.id)});return}
    if(url.pathname==='/api/export'){json(res,200,viewFor(await db.snapshot(),actor));return}
    if(url.pathname==='/api/guest/upgrade'&&req.method==='POST'){
      if(!actor.verified)throw new Error('UNAUTHORIZED');const guestReq={headers:{authorization:'Bearer '+String(req.headers['x-guest-capability']||'')}} as typeof req;const guest=await authenticate(guestReq,state);if(!state.profiles[guest.id]?.guest)throw new Error('UNAUTHORIZED');
      await db.command({id:'gateway',kind:'gateway'},{name:'upgrade_guest',operationId:randomUUID(),body:{oldId:guest.id,newId:actor.id,verified:true}});json(res,200,{ok:true});return;
    }
    if(url.pathname==='/api/intake/analyze'&&req.method==='POST'){
      const input=JSON.parse(await rawBody(req));if(typeof input.text!=='string'||input.text.length>2000)throw new Error('INVALID_INPUT');const result=await extractIntake(input.text,input.language==='es'?'es':'en');if(!result.live)counters.modelFallbacks++;json(res,200,result);return;
    }
    if(url.pathname==='/api/command'&&req.method==='POST'){
      const input=JSON.parse(await rawBody(req)) as Command;if(!allowed.has(input.name))throw new Error('UNKNOWN_COMMAND');
      const result=await db.command(actor,input);
      if(input.name==='set_consent'&&input.body.granted!==true){frames.get(actor.id)?.controller.abort();frames.delete(actor.id)}
      if(['end_call','decline_call','delete_account'].includes(input.name)||(input.name==='set_consent'&&input.body.type==='microphone'&&input.body.granted!==true)){
        frames.get(actor.id)?.controller.abort();frames.delete(actor.id);
        const updated=await db.snapshot();for(const call of Object.values(updated.calls).filter(c=>c.ownerId===actor.id&&(['ended','failed'].includes(c.state)||input.name==='set_consent'))){await rooms.deleteRoom(call.roomId).catch(()=>{});}
      }
      json(res,200,{result,view:viewFor(await db.snapshot(),actor)});return;
    }
    if(url.pathname==='/api/media/token'&&req.method==='POST'){
      const input=JSON.parse(await rawBody(req)),fresh=await db.snapshot(),call=fresh.calls[input.callId];
      if(!call||call.ownerId!==actor.id||call.deviceId!==input.deviceId||!['connecting','active_ai','reconnecting'].includes(call.state)||call.expiresAt<=Date.now())throw new Error('UNAUTHORIZED');
      const c=fresh.cases[call.caseId];if(!consent(fresh,c,'microphone'))throw new Error('CONSENT_REQUIRED');
      const token=new AccessToken(process.env.LIVEKIT_API_KEY,process.env.LIVEKIT_API_SECRET,{identity:actor.id,ttl:'5m',metadata:JSON.stringify({callId:call.id})});token.addGrant({roomJoin:true,room:call.roomId,canPublish:true,canSubscribe:true,canPublishData:true,canPublishSources:consent(fresh,c,'camera')?[1,2]:[2]});
      await rooms.createRoom({name:call.roomId,emptyTimeout:60,maxParticipants:3});
      const agents=await dispatch.listDispatch(call.roomId);if(!agents.length)await dispatch.createDispatch(call.roomId,'relayaid',{metadata:JSON.stringify({callId:call.id})});
      json(res,200,{token:await token.toJwt(),url:process.env.LIVEKIT_PUBLIC_URL||process.env.LIVEKIT_URL,recording:false,speechLanguages:[]});return;
    }
    if(url.pathname==='/api/media/frame'&&req.method==='POST'){
      const input=JSON.parse(await rawBody(req,1500000)),fresh=await db.snapshot(),call=fresh.calls[input.callId];if(!call||call.ownerId!==actor.id||!['connecting','active_ai'].includes(call.state))throw new Error('UNAUTHORIZED');const c=fresh.cases[call.caseId];
      if(!consent(fresh,c,'camera')||!consent(fresh,c,'vision'))throw new Error('CONSENT_REQUIRED');
      if(frames.has(actor.id)&&Date.now()-frames.get(actor.id)!.at<3000)throw new Error('RATE_LIMIT');
      if(typeof input.image!=='string'||!/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/.test(input.image))throw new Error('INVALID_INPUT');
      frames.get(actor.id)?.controller.abort();const controller=new AbortController();frames.set(actor.id,{at:Date.now(),controller});
      const result=await analyzeFrame(input.image,controller.signal);const latest=await db.snapshot();if(controller.signal.aborted||!consent(latest,latest.cases[c.id],'vision')||latest.calls[call.id].state==='ended')throw new Error('CONSENT_REQUIRED');json(res,200,result);return;
    }
    if(url.pathname==='/api/logout'&&req.method==='POST'){
      frames.get(actor.id)?.controller.abort();frames.delete(actor.id);
      for(const call of Object.values(state.calls).filter(c=>c.ownerId===actor.id&&!['ended','failed'].includes(c.state))){await db.command(actor,{name:'end_call',operationId:randomUUID(),body:{callId:call.id,deviceId:call.deviceId}});await rooms.deleteRoom(call.roomId).catch(()=>{})}
      json(res,200,{ok:true});return;
    }
    json(res,404,{error:'NOT_FOUND'});
  } catch(error){counters.rejected++;const code=safeError(error);json(res,code==='UNAUTHORIZED'?401:code==='DATABASE_UNAVAILABLE'?503:400,{error:code})}
});
server.listen(Number(process.env.GATEWAY_PORT||4100),'0.0.0.0',()=>console.log(JSON.stringify({service:'gateway',ready:true})));
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{for(const f of frames.values())f.controller.abort();clearInterval(referralTimer);server.close();db.close()});
