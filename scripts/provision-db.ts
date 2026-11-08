import {readFileSync,writeFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {spawnSync} from 'node:child_process';
const env=parseEnv(readFileSync('.env','utf8'));
for(const role of ['GATEWAY','AGENT']) {
  if(env[role+'_TOKEN']&&env[role+'_IDENTITY'])continue;
  const res=await fetch('http://127.0.0.1:3000/v1/identity',{method:'POST',signal:AbortSignal.timeout(10000)});
  if(!res.ok)throw new Error('IDENTITY_PROVISION_FAILED');
  const body=await res.json() as {identity:string;token:string};
  env[role+'_IDENTITY']=body.identity;env[role+'_TOKEN']=body.token;
}
writeFileSync('.env',Object.entries(env).map(([k,v])=>`${k}=${v}`).join('\n')+'\n',{mode:0o600});
const args=['--root-dir=.tools/spacetime','publish','relayaid-autonomy','--server','http://127.0.0.1:3000','--module-path','spacetimedb','--delete-data=never','--yes=skip-login,migrate,break-clients'];
const result=spawnSync('.tools/spacetime/spacetime',args,{stdio:'inherit',env:{...process.env,...env,AUTH_MODE:'real',AI_MODE:'queue'}});
if(result.status!==0)process.exit(result.status||1);
const generate=spawnSync('.tools/spacetime/spacetime',['--root-dir=.tools/spacetime','generate','--lang','typescript','--out-dir','src/module_bindings','--module-path','spacetimedb','--yes'],{stdio:'inherit'});
process.exit(generate.status||0);
