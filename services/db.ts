import {DbConnection} from '../src/module_bindings/index.ts';
import type {Actor, Command, State} from '../shared/autonomy/contracts.ts';
export class Database {
  private conn?: DbConnection;
  private opening?: Promise<DbConnection>;
  private mode:'GATEWAY'|'AGENT';
  constructor(mode:'GATEWAY'|'AGENT'){this.mode=mode}
  async connect():Promise<DbConnection> {
    if(this.conn?.isActive)return this.conn;
    if(this.opening)return this.opening;
    this.opening=new Promise<DbConnection>((resolve,reject)=>{
      const timeout=setTimeout(()=>{connection.disconnect();reject(new Error('DATABASE_UNAVAILABLE'))},10000);
      const connection=DbConnection.builder().withUri(process.env.SPACETIME_URI||'ws://127.0.0.1:3000').withDatabaseName(process.env.SPACETIME_DB_NAME||'relayaid-autonomy').withToken(process.env[this.mode+'_TOKEN'])
        .onConnect(conn=>{
          conn.subscriptionBuilder().onApplied(()=>{clearTimeout(timeout);this.conn=conn;resolve(conn)})
            .onError(()=>{clearTimeout(timeout);reject(new Error('DATABASE_UNAVAILABLE'))})
            .subscribe(this.mode==='GATEWAY'?'SELECT * FROM gateway_state':'SELECT * FROM agent_work');
        }).onConnectError(()=>{clearTimeout(timeout);reject(new Error('DATABASE_UNAVAILABLE'))})
        .onDisconnect(()=>{this.conn=undefined}).build();
    }).finally(()=>{this.opening=undefined});
    return this.opening;
  }
  async snapshot():Promise<State>{const conn=await this.connect();const row=[...conn.db.gatewayState.iter()][0];if(!row)throw new Error('DATABASE_UNAVAILABLE');return JSON.parse(row.json)}
  async work(){const conn=await this.connect();const row=[...conn.db.agentWork.iter()][0];if(!row)throw new Error('DATABASE_UNAVAILABLE');return JSON.parse(row.json) as {revision:number;jobs:State['jobs'];policyVersion:number}}
  async command(actor:Actor,command:Command){const conn=await this.connect();await conn.reducers.autonomyCommand({actorJson:JSON.stringify(actor),commandJson:JSON.stringify(command)});if(this.mode==='GATEWAY'){const s=await this.snapshot();return s.receipts[`${actor.kind}:${actor.id}:${command.operationId}`]?.result}return {ok:true}}
  close(){this.conn?.disconnect();this.conn=undefined}
}
