const base = import.meta.env.VITE_GATEWAY_URL ?? ''
let bearer='';
export function setGatewayToken(token:string){bearer=token}
export function gatewayToken(){return bearer}
export async function api<T=any>(path:string,body?:unknown,signal?:AbortSignal,extra?:Record<string,string>):Promise<T>{const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${bearer}`,'content-type':'application/json',...extra},body:body===undefined?undefined:JSON.stringify(body),signal});const data=await r.json();if(!r.ok)throw new Error(data.error||'REQUEST_FAILED');return data}
