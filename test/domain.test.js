import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVideoUrl, resolveVideoUrl, parseDisplayCount, parseKeywords, matchKeywords, intervalMs } from '../src/domain.js';

test('canonical Douyin URL from pasted share text', () => {
  assert.equal(normalizeVideoUrl('复制 https://www.douyin.com/video/7673152596441304358 看看'), 'https://www.douyin.com/video/7673152596441304358');
  assert.throws(() => normalizeVideoUrl('https://evil.example/video/7673152596441304358'), /抖音/);
});

test('display count keeps raw label and parses approximate value', () => {
  assert.deepEqual(parseDisplayCount('3.2万'), { display: '3.2万', value: 32000, approximate: true });
  assert.deepEqual(parseDisplayCount('1,234'), { display: '1,234', value: 1234, approximate: false });
  assert.equal(parseDisplayCount('未知').value, null);
});

test('keywords use Chinese delimiter and latin case insensitive matching', () => {
  const words = parseKeywords('投诉、 AI 、投诉、、词语C');
  assert.deepEqual(words, ['投诉', 'AI', '词语C']);
  assert.deepEqual(matchKeywords('AI 产品收到投诉', words), ['投诉', 'AI']);
});

test('interval is an exact HH:MM:SS with safe range', () => {
  assert.equal(intervalMs('00:30:00'), 1800000);
  assert.throws(() => intervalMs('30分钟'));
  assert.throws(() => intervalMs('00:00:05'));
});

test('official Douyin short link resolves to canonical video URL', async () => {
  const url = await resolveVideoUrl('分享 https://v.douyin.com/abc123/ 打开', async () => ({ url: 'https://www.douyin.com/video/7673152596441304358?previous_page=web_code_link' }));
  assert.equal(url,'https://www.douyin.com/video/7673152596441304358');
});
