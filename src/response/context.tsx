import {createContext,useCallback,useContext,useEffect,useRef,useState,type ReactNode} from 'react'
import type {Command,View} from '../../shared/autonomy/contracts.ts'
import {api,setGatewayToken} from '../lib/gateway.ts'
import {PrivateOutbox} from '../../client/privateOutbox.ts'
import {lockOutbox} from '../lib/outboxClient.ts'
export type Pending={clientRequestId:string;ownerIdentity:string;recordType:'case-command';command:Command;savedAt:number}
type ResponseContext={view:View|null;error:string;pending:Pending[];refresh:()=>Promise<void>;mutate:(name:string,body?:Record<string,unknown>,caseId?:string,expectedVersion?:number)=>Promise<any>;submit:(command:Command)=>Promise<{saved:boolean}>;logout:()=>Promise<void>;language:'en'|'es';setLanguage:(language:'en'|'es')=>void}
const Context=createContext<ResponseContext|null>(null)
export function useResponse(){const value=useContext(Context);if(!value)throw new Error('Response context missing');return value}
export function ResponseProvider({token,onLogout,children}:{token:string;onLogout:()=>Promise<void>;children:ReactNode}){
 const [view,setView]=useState<View|null>(null),[error,setError]=useState(''),[pending,setPending]=useState<Pending[]>([]),[language,setLanguage]=useState<'en'|'es'>('en')
 const store=useRef<PrivateOutbox<Pending>|null>(null),identity=useRef(''),generation=useRef(0),replaying=useRef(false)
 const refresh=useCallback(async()=>{const epoch=generation.current;try{const next=await api<View>('/api/state');if(epoch!==generation.current)return;if(identity.current&&identity.current!==next.profile.id)throw new Error('IDENTITY_CHANGED');identity.current=next.profile.id;setView(next);setError('')}catch(e){if(epoch===generation.current)setError(e instanceof Error?e.message:'Connection unavailable')}},[])
 useEffect(()=>{generation.current++;const epoch=generation.current;setView(null);setPending([]);identity.current='';setGatewayToken(token);lockOutbox();let active=true
  void (async()=>{try{const v=await api<View>('/api/session');if(!active)return;identity.current=v.profile.id;setView(v);const key=await api<{ownerIdentity:string;key:string}>('/api/outbox-key');if(!active||key.ownerIdentity!==v.profile.id)return;const unlocked=await PrivateOutbox.unlock<Pending>(key.ownerIdentity,key.key);const items=(await unlocked.all()).filter(x=>x.recordType==='case-command');if(!active){unlocked.lock();return}store.current=unlocked;setPending(items)}catch(e){if(active)setError(e instanceof Error?e.message:'Connection unavailable')}})()
  const timer=setInterval(()=>void refresh(),2000)
  return()=>{active=false;clearInterval(timer);if(epoch===generation.current)generation.current++;store.current?.lock();store.current=null;setGatewayToken('');lockOutbox()}
 },[token,refresh])
 useEffect(()=>{if(!view||error||!store.current||replaying.current||!pending.length)return;replaying.current=true;const epoch=generation.current
  void (async()=>{try{const verification=await api<{ownerIdentity:string}>('/api/outbox-key');if(verification.ownerIdentity!==identity.current||epoch!==generation.current)return;for(const item of pending){if(epoch!==generation.current)break;await api('/api/command',item.command);await store.current?.remove(item.clientRequestId);setPending(rows=>rows.filter(x=>x.clientRequestId!==item.clientRequestId))}await refresh()}catch{ /* Remains encrypted until the verified owner can replay. */ }finally{replaying.current=false}})()
 },[pending,view?.revision,error,refresh])
 async function mutate(name:string,body:Record<string,unknown>={},caseId?:string,expectedVersion?:number){const epoch=generation.current;const result=await api<{result:unknown;view:View}>('/api/command',{name,body,caseId,expectedVersion,operationId:crypto.randomUUID()});if(epoch===generation.current)setView(result.view);return result.result}
 async function submit(command:Command){if(!store.current||!identity.current)throw new Error('Private storage is unavailable. Reconnect and sign in before saving.');const row:Pending={clientRequestId:command.operationId,ownerIdentity:identity.current,recordType:'case-command',command,savedAt:Date.now()};await store.current.put(row);setPending(p=>[...p,row]);return {saved:true}}
 async function logout(){generation.current++;setView(null);setPending([]);store.current?.lock();store.current=null;lockOutbox();window.dispatchEvent(new Event('relayaid-stop-media'));try{await api('/api/logout',{})}catch{}setGatewayToken('');await onLogout()}
 return <Context.Provider value={{view,error,pending,refresh,mutate,submit,logout,language,setLanguage}}>{children}</Context.Provider>
}
