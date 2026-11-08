import assert from 'node:assert/strict';
import test from 'node:test';
import { checkTool, fallbackResult, modelConfigured } from './guard.ts';

test('unknown tools and other shelters are refused', () => {
  const snapshot = { resourceIds: ['water-a'], requestIds: ['1'], snapshotVersion: '4' };
  assert.equal(checkTool('shelter-a', 'approve_plan', {}).code, 'UNKNOWN_TOOL');
  assert.equal(
    checkTool('shelter-a', 'list_stalled_requests', { shelter_id: 'shelter-b' }).code,
    'WRONG_SHELTER',
  );
  assert.equal(
    checkTool('shelter-a', 'run_what_if', { change: 'transfer', count: 9 }).ok,
    true,
  );
  assert.equal(checkTool('shelter-a', 'run_plan', { strategy: 'suitability' }).ok, true);
  assert.equal(
    checkTool('shelter-a', 'run_plan', { strategy: 'suitability', resource_id: 'missing' }, snapshot).code,
    'NOT_FOUND',
  );
  assert.equal(
    checkTool('shelter-a', 'run_plan', { strategy: 'suitability', snapshot_version: '1' }, snapshot).code,
    'STALE_PLAN',
  );
});

test('missing model configuration is a labelled fallback, not a Nemotron result', () => {
  assert.equal(modelConfigured({}), false);
  const result = fallbackResult('shelter-a');
  assert.equal(result.nemotron, false);
  assert.match(result.explanation, /Model unavailable; deterministic plan only/);
});
