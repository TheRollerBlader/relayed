/** Fictional responder service only. Never dispatches a real organization. */
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {json,rawBody,sign,verify,safeError} from '../http.ts';
const directory=process.env.SANDBOX_DATA_DIR||'runtime/generated/sandbox';mkdirSync(directory,{recursive:true});
const db=new DatabaseSync(directory+'/referrals.sqlite');db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS referrals (id TEXT PRIMARY KEY, body TEXT NOT NULL, state TEXT NOT NULL, seq INTEGER NOT NULL, next_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)');
const secret=process.env.REFERRAL_SECRET!;
const callbackUrl=process.env.SANDBOX_CALLBACK_URL||'http://127.0.0.1:4100/callbacks/referral-events';
if(!['127.0.0.1','localhost','gateway'].includes(new URL(callbackUrl).hostname))throw new Error('SANDBOX_ENDPOINT_REQUIRED');
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url||'/','http://localhost');if(url.pathname==='/health'){json(res,200,{ok:true,synthetic:true});return}
    const body=req.method==='POST'?await rawBody(req):'';
    if(!verify(body,String(req.headers['x-relay-timestamp']||''),String(req.headers['x-relay-signature']||''),secret))throw new Error('UNAUTHORIZED');
    if(req.method==='POST'&&url.pathname==='/referrals'){
      const data=JSON.parse(body);if(!data.id||!data.service?.id||!data.service?.orgId||!['normal','busy','reject','no_ack','duplicate','out_of_order'].includes(data.service.mode))throw new Error('INVALID_INPUT');
      // Pre-acceptance payload must have no precise position or original narrative.
      if(data.location||data.lat!==undefined||data.lon!==undefined||data.text)throw new Error('INVALID_INPUT');
      const prior=db.prepare('SELECT body FROM referrals WHERE id=?').get(data.id) as {body:string}|undefined;
      if(prior&&prior.body!==body)throw new Error('IDEMPOTENCY_CONFLICT');
      if(!prior)db.prepare('INSERT INTO referrals(id,body,state,seq,next_at) VALUES (?,?,?,?,?)').run(data.id,body,'received',0,Date.now()+data.service.delayMs);
      json(res,202,{id:data.id,receipt:'received',synthetic:true});return;
    }
    const match=url.pathname.match(/^\/referrals\/([a-zA-Z0-9_-]+)$/);if(req.method==='GET'&&match){const row=db.prepare('SELECT id,state,seq FROM referrals WHERE id=?').get(match[1]);json(res,row?200:404,row||{error:'NOT_FOUND'});return}
    json(res,404,{error:'NOT_FOUND'});
  }catch(e){json(res,400,{error:safeError(e)})}
});
let busy=false;
async function send(body:string){const stamp=String(Date.now());const r=await fetch(callbackUrl,{method:'POST',headers:{'content-type':'application/json','x-relay-timestamp':stamp,'x-relay-signature':sign(body,stamp,secret)},body,signal:AbortSignal.timeout(5000)});if(!r.ok)throw new Error('CALLBACK_UNCONFIRMED')}
const timer=setInterval(async()=>{
  if(busy)return;busy=true;
  try{
    const rows=db.prepare('SELECT * FROM referrals WHERE next_at<=? AND state NOT IN (\'resolved\',\'declined\',\'busy\',\'no_ack\',\'callback_failed\') LIMIT 4').all(Date.now()) as any[];
    for(const row of rows){const body=JSON.parse(row.body),srv=body.service;
      if(srv.mode==='no_ack'){db.prepare('UPDATE referrals SET state=? WHERE id=?').run('no_ack',row.id);continue}
      const flow=['received','acked','accepted','dispatched','en_route','arrived','resolved'];let next=flow[flow.indexOf(row.state)+1]||'acked';
      if(row.state==='acked'&&(!srv.available||srv.capacity<=0||srv.mode==='busy'))next='busy';
      else if(row.state==='acked'&&srv.mode==='reject')next='declined';
      else if(row.state==='acked'&&!srv.autoAccept){db.prepare('UPDATE referrals SET next_at=? WHERE id=?').run(Date.now()+10000,row.id);continue}
      const event={referralId:row.id,orgId:srv.orgId,state:next,seq:row.seq+1};
      try{
        await send(JSON.stringify(event));
        if(srv.mode==='duplicate')await send(JSON.stringify(event));
        if(srv.mode==='out_of_order'&&event.seq>1)await send(JSON.stringify({...event,seq:event.seq-1,state:'acked'}));
        db.prepare('UPDATE referrals SET state=?,seq=?,next_at=?,attempts=0 WHERE id=?').run(next,event.seq,Date.now()+Math.max(srv.delayMs,1500),row.id);
      }catch{const attempts=row.attempts+1;db.prepare('UPDATE referrals SET attempts=?,next_at=?,state=? WHERE id=?').run(attempts,Date.now()+Math.min(30000,1000*2**attempts),attempts>=6?'callback_failed':row.state,row.id)}
    }
  }finally{busy=false}
},1000);
server.listen(Number(process.env.SANDBOX_PORT||4200),'0.0.0.0',()=>console.log(JSON.stringify({service:'responder-sandbox',synthetic:true,ready:true})));
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{clearInterval(timer);server.close(()=>db.close())});
