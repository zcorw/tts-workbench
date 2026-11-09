import test from 'node:test';
import assert from 'node:assert/strict';
import { publishBatch } from '../src/features/publishBatch.ts';
const article = (id, extra = {}) => ({
  id,
  title: id,
  revision: 3,
  cms: { revision: 5 },
  audio: null,
  ...extra,
});
const options = (publish) => ({ publish, active: () => true, progress: () => {} });
test('requires explicit text-only consent before making any request', async () => {
  let calls = 0;
  await assert.rejects(
    publishBatch(
      [article('a')],
      false,
      options(async () => calls++),
    ),
  );
  assert.equal(calls, 0);
});
test('preserves selected versions, uses valid saved audio, does not use stale audio', async () => {
  const calls = [];
  const articles = [
    article('a', { audio: { audioId: 'audio-a' } }),
    article('b', { audio: { audioId: 'old' }, audioStale: true }),
  ];
  const result = await publishBatch(
    articles,
    true,
    options(async (a, audioId) => calls.push([a, audioId])),
  );
  assert.deepEqual(calls, [
    [articles[0], 'audio-a'],
    [articles[1], null],
  ]);
  assert(result.every((r) => r.status === 'success'));
});
test('revision conflict gives partial success without retrying or refreshing revisions', async () => {
  const calls = [];
  const result = await publishBatch(
    ['a', 'b', 'c'].map((x) => article(x)),
    true,
    options(async (a) => {
      calls.push(a.id);
      if (a.id === 'b') throw { code: 'CMS_REVISION_CONFLICT' };
    }),
  );
  assert.deepEqual(calls, ['a', 'b', 'c']);
  assert.deepEqual(
    result.map((r) => r.status),
    ['success', 'failed', 'success'],
  );
  assert.match(result[1].message, /版本冲突/);
});
test('session loss stops all remaining writes', async () => {
  let calls = 0;
  const result = await publishBatch(
    ['a', 'b', 'c'].map((x) => article(x)),
    true,
    options(async () => {
      calls++;
      throw { code: 'SESSION' };
    }),
  );
  assert.equal(calls, 1);
  assert.deepEqual(
    result.map((r) => r.status),
    ['failed', 'skipped', 'skipped'],
  );
});
test('unmount stops remaining writes, successful current write remains reported', async () => {
  let active = true;
  const result = await publishBatch([article('a'), article('b')], true, {
    ...options(async () => {
      active = false;
    }),
    active: () => active,
  });
  assert.deepEqual(
    result.map((r) => r.status),
    ['success', 'skipped'],
  );
});
test('network uncertainty is reported without automatic retry', async () => {
  let calls = 0;
  const result = await publishBatch(
    [article('a')],
    true,
    options(async () => {
      calls++;
      throw Error('network');
    }),
  );
  assert.equal(calls, 1);
  assert.match(result[0].message, /未能确认/);
});
test('limits batch size and rejects duplicate IDs before any writes', async () => {
  const opts = options(async () => assert.fail('must not write'));
  for (const items of [
    [],
    [article('a'), article('a')],
    Array.from({ length: 21 }, (_, i) => article(String(i))),
  ])
    await assert.rejects(publishBatch(items, true, opts));
});

test('audio and release limits remain distinct failures', async () => {
  const result = await publishBatch(
    [article('a'), article('b')],
    true,
    options(async (a) => {
      throw { code: a.id === 'a' ? 'AUDIO_STALE' : 'RELEASE_LIMIT' };
    }),
  );
  assert.match(result[0].message, /音频/);
  assert.match(result[1].message, /发布历史/);
});
test('requests are sequential and progress reports each settled article', async () => {
  let active = 0,
    max = 0;
  const progress = [];
  await publishBatch([article('a'), article('b')], true, {
    ...options(async () => {
      active++;
      max = Math.max(max, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
    }),
    progress: (r) => progress.push(r.length),
  });
  assert.equal(max, 1);
  assert.deepEqual(progress, [1, 2]);
});
