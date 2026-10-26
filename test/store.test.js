import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';

test('video, comments and alerts persist; deletion cascades', () => {
  const db = createStore(':memory:');
  const video = db.addVideo('https://www.douyin.com/video/123', '00:30:00');
  assert.equal(db.addComment({ videoId: video.id, fingerprint: 'c1', body: '测试', author: 'A', source: 'historical', discoveredAt: '2026-10-24T00:00:00.000Z' }).inserted, true);
  assert.equal(db.addComment({ videoId: video.id, fingerprint: 'c1', body: '测试', author: 'A', source: 'historical', discoveredAt: '2026-10-24T00:00:00.000Z' }).inserted, false);
  db.addObservation(video.id, { likesDisplay: '3.2万', likesValue: 32000, commentsDisplay: '343', commentsValue: 343, observedAt: '2026-10-24T00:00:00.000Z' });
  db.queueAlert(video.id, 'keyword', { count: 1 });
  assert.equal(db.listComments(video.id).length, 1);
  assert.equal(db.listAlerts().length, 1);
  db.close();
});

test('deleting a video removes its local comments observations and alerts', () => {
  const db = createStore(':memory:');
  const v = db.addVideo('https://www.douyin.com/video/123', '00:30:00');
  db.addComment({ videoId: v.id, fingerprint: 'a', body: 'a', source: 'new', discoveredAt: new Date().toISOString() });
  db.addObservation(v.id, { likesDisplay: '5', likesValue: 5, commentsDisplay: '1', commentsValue: 1, observedAt: new Date().toISOString() });
  db.queueAlert(v.id, 'keyword', {});
  db.deleteVideos([v.id]);
  assert.equal(db.getVideo(v.id), undefined);
  assert.equal(db.listComments(v.id).length, 0);
  assert.equal(db.listAlerts().length, 0);
  db.close();
});

test('alert pagination and filters reach older records', () => {
  const db=createStore(':memory:');const v=db.addVideo('https://www.douyin.com/video/123','00:30:00');
  const ids=Array.from({length:120},(_,i)=>db.queueAlert(v.id,i%2?'new_keyword':'likes_threshold',{}).id);
  const first=db.listAlerts({limit:50,videoId:v.id,kind:'new_keyword'});
  const second=db.listAlerts({limit:50,videoId:v.id,kind:'new_keyword',beforeId:first.at(-1).id});
  assert.equal(first.length,50);assert.equal(second.length,10);
  assert.ok(second.at(-1).id<first.at(-1).id);
  db.close();
});
