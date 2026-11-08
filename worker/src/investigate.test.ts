import assert from 'node:assert/strict';
import test from 'node:test';
import { investigate } from './index.ts';
import { executeClaimedJob } from './runner.ts';

const env = {
  NEMOTRON_BASE_URL: 'https://model.example',
  NEMOTRON_API_KEY: 'server-secret',
  NEMOTRON_MODEL: 'nemotron',
  RELAYAID_SHELTER_ID: 'shelter-a',
};

test('a provider error is retried once and then labelled fallback', async () => {
  let calls = 0;
  const result = await investigate(env, async () => ({ ok: true }), async () => {
    calls += 1;
    return new Response('no', { status: 503 });
  });
  assert.equal(calls, 2);
  assert.equal(result.nemotron, false);
  assert.equal(result.outcome, 'timeout');
  assert.match(result.explanation, /Model unavailable; deterministic plan only/);
});

test('a missing model never records a live trace', async () => {
  const events: { live: boolean }[] = [];
  let finished: { outcome: string; live: boolean } | undefined;
  await executeClaimedJob({ RELAYAID_SHELTER_ID: 'shelter-a' }, { jobId: 1n, shelterId: 'shelter-a' }, {
    async append(input) {
      events.push(input);
    },
    async finish(_jobId, outcome, _explanation, live) {
      finished = { outcome, live };
    },
    async execute() {
      return { served: 1 };
    },
  });
  assert.equal(events.length, 0);
  assert.equal(finished?.outcome, 'fallback');
  assert.equal(finished?.live, false);
});

test('one model response cannot exceed the six tool-call budget', async () => {
  let executed = 0;
  const result = await investigate(env, async () => {executed++;return {}}, async () => Response.json({choices:[{message:{tool_calls:Array.from({length:7},(_,i)=>({id:String(i),function:{name:'list_resources',arguments:'{}'}}))}}]}));
  assert.equal(executed,0);
  assert.equal(result.explanation,'TOOL_BUDGET_EXCEEDED');
});

test('a hung provider is aborted at the actual deadline', async () => {
  let signal: AbortSignal | undefined;
  const start=Date.now();
  const result=await investigate(env,async()=>({}), async (_url,init)=>{signal=init?.signal as AbortSignal;return new Promise(()=>{})},25);
  assert.equal(result.outcome,'timeout');assert.equal(signal?.aborted,true);assert.ok(Date.now()-start<250);
});
