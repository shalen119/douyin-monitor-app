import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { buildFeishuBody, validateWebhook } from '../src/feishu.js';

test('optional Feishu signing follows official timestamp and secret algorithm', () => {
  const alert={created_at:'2026-10-24T00:00:00.000Z',payload:{title:'作品',url:'https://www.douyin.com/video/123',reason:'命中'}};
  const body=buildFeishuBody(alert,'secret',1599360473);
  assert.equal(body.timestamp,'1599360473');
  assert.equal(body.sign,createHmac('sha256','1599360473\nsecret').update('').digest('base64'));
  assert.equal(body.msg_type,'text');
  assert.match(body.content.text,/作品/);
});

test('Webhook only accepts official Feishu bot hosts and path', () => {
  assert.equal(validateWebhook('https://open.feishu.cn/open-apis/bot/v2/hook/demo'),'https://open.feishu.cn/open-apis/bot/v2/hook/demo');
  assert.throws(()=>validateWebhook('http://localhost/open-apis/bot/v2/hook/demo'));
});

test('threshold Feishu message names the work and baseline increase', () => {
  const alert={created_at:'2026-10-24T00:00:00.000Z',kind:'likes_threshold',payload:{title:'作品甲',url:'https://www.douyin.com/video/123',reason:'点赞量达到 33000',likesDisplay:'3.5万',baselineDisplay:'3.2万',deltaSinceFirst:3000,approximate:true}};
  const text=buildFeishuBody(alert).content.text;
  assert.match(text,/作品甲/);
  assert.match(text,/video\/123/);
  assert.match(text,/首次采集：3.2万/);
  assert.match(text,/较首次采集：约\+3,000/);
});
