import test from 'node:test';
import assert from 'node:assert/strict';
import { mapDetail, mapCommentBatch, extractDisplayedMetrics, waitForInitialBatch } from '../src/douyin.js';

test('maps page-observed detail with exact stats and displayed labels', () => {
  const detail = { status_code: 0, aweme_detail: { desc: '作品 A', statistics: { digg_count: 32440, comment_count: 343 } } };
  const result = mapDetail(detail, '作品 A\n3.2万\n343\n2.8万');
  assert.deepEqual(result, { title: '作品 A', likesDisplay: '3.2万', likesValue: 32000, commentsDisplay: '343', commentsValue: 343 });
});

test('maps comments to stable platform ids and text', () => {
  const result = mapCommentBatch({ status_code: 0, total: 2, has_more: 0, cursor: 2, comments: [
    { cid: '999', text: 'AI 好用', user: { nickname: '小明' }, create_time: 1780000000 }
  ] });
  assert.equal(result.comments[0].fingerprint, 'douyin:999');
  assert.equal(result.comments[0].body, 'AI 好用');
  assert.equal(result.comments[0].author, '小明');
  assert.equal(result.hasMore, false);
});

test('display metric extraction returns unknown rather than fabricated value', () => {
  assert.deepEqual(extractDisplayedMetrics('作品 A\n统计不可用', '作品 A'), { likesDisplay: '', commentsDisplay: '' });
});

test('collector waits for delayed initial comment response', async () => {
  let batches = 0;
  let elapsed = 0;
  const page = { waitForTimeout: async ms => { elapsed += ms; if (elapsed >= 1500) batches = 1; } };
  await waitForInitialBatch(page, () => batches, 3000);
  assert.equal(batches, 1);
  assert.ok(elapsed >= 1500);
});
