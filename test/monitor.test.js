import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createMonitor } from '../src/monitor.js';

const C = (id, body) => ({ fingerprint: `douyin:${id}`, platformId: id, body, author: '作者', publishedAt: '2026-10-24T00:00:00.000Z' });
const result = comments => ({ title: '作品', likesDisplay: '3.2万', likesValue: 32000, commentsDisplay: '343', commentsValue: 343, comments, hasMore: false, complete: false, loginRequired: false, note: '回复未展开' });

test('historical backfill is separate from later new comments and deduplicates rechecks', async () => {
  const store = createStore(':memory:');
  const video = store.addVideo('https://www.douyin.com/video/123', '00:30:00', 2);
  store.setSettings({ keywords: '投诉', likesThreshold: '30000' });
  let call = 0;
  const collector = { collect: async () => result(call++ ? [C('1','投诉'),C('2','普通'),C('3','投诉 新评论')] : [C('1','投诉'),C('2','普通')]) };
  const monitor = createMonitor({ store, collector, sender: { send: async () => {} } });
  await monitor.checkVideo(video.id);
  assert.equal(store.countComments(video.id,'historical'),2);
  assert.equal(store.getVideo(video.id).backfillDone,true);
  assert.equal(store.listAlerts().filter(a=>a.kind==='historical_keyword').length,1);
  assert.equal(store.listAlerts().filter(a=>a.kind==='likes_threshold').length,1);
  await monitor.checkVideo(video.id);
  assert.equal(store.countComments(video.id,'new'),1);
  assert.equal(store.listAlerts().filter(a=>a.kind==='new_keyword').length,1);
  assert.equal(store.listAlerts().filter(a=>a.kind==='likes_threshold').length,1);
  store.close();
});

test('paused videos do not collect and resume labels caught-up comments', async () => {
  const store=createStore(':memory:'); const video=store.addVideo('https://www.douyin.com/video/123','00:30:00',0);
  let calls=0; const monitor=createMonitor({store,collector:{collect:async()=>{calls++;return result([C('x','内容')])}},sender:{send:async()=>{}}});
  store.updateVideo(video.id,{paused:1}); await monitor.checkVideo(video.id); assert.equal(calls,0);
  monitor.resume(video.id); await monitor.checkVideo(video.id);
  assert.equal(store.countComments(video.id,'recovery'),1);
  store.close();
});

test('rematch only newly matched stored comments; failed Feishu alert remains pending', async () => {
  const store=createStore(':memory:'); const video=store.addVideo('https://www.douyin.com/video/123','00:30:00');
  store.addComment({videoId:video.id,fingerprint:'a',body:'新的词',source:'historical',discoveredAt:'2026-10-24T00:00:00.000Z'});
  store.setSettings({keywords:'新的词',feishuWebhook:'https://open.feishu.cn/open-apis/bot/v2/hook/demo'});
  const monitor=createMonitor({store,collector:{collect:async()=>result([])},sender:{send:async()=>{throw new Error('断网')}}});
  monitor.rematch(); monitor.rematch();
  assert.equal(store.listAlerts().filter(a=>a.kind==='rematch_keyword').length,1);
  await monitor.deliverPending();
  assert.equal(store.listAlerts({pending:true}).length,1);
  assert.equal(store.listAlerts({pending:true})[0].attempts,1);
  store.close();
});

test('multi-round historical backfill sends one summary only after it ends', async () => {
  const store=createStore(':memory:'); const video=store.addVideo('https://www.douyin.com/video/123','00:30:00',3);
  store.setSettings({keywords:'投诉'}); let round=0;
  const collector={collect:async()=>{round++;return {...result(round===1?[C('1','投诉')]:[C('1','投诉'),C('2','普通'),C('3','投诉')]),hasMore:round===1}}};
  const monitor=createMonitor({store,collector,sender:{send:async()=>{}}});
  await monitor.checkVideo(video.id); assert.equal(store.listAlerts().filter(a=>a.kind==='historical_keyword').length,0);
  await monitor.checkVideo(video.id); const alerts=store.listAlerts().filter(a=>a.kind==='historical_keyword');
  assert.equal(alerts.length,1); assert.equal(alerts[0].payload.count,2);
  store.close();
});

test('changing a threshold evaluates the latest saved value once', () => {
  const store=createStore(':memory:'); const video=store.addVideo('https://www.douyin.com/video/123','00:30:00');
  store.updateVideo(video.id,{title:'作品',likes_display:'3.2万',likes_value:32000});
  const monitor=createMonitor({store,collector:{collect:async()=>result([])},sender:{send:async()=>{}}});
  store.setSettings({likesThreshold:'30000'});
  monitor.recheckThresholds();monitor.recheckThresholds();
  assert.equal(store.listAlerts().filter(a=>a.kind==='likes_threshold').length,1);
  store.setSettings({likesThreshold:'40000'});monitor.recheckThresholds();
  assert.equal(store.listAlerts().filter(a=>a.kind==='likes_threshold').length,1);
  store.close();
});

test('threshold alert reports the work and change since first collection to Feishu', async () => {
  const store=createStore(':memory:'); const video=store.addVideo('https://www.douyin.com/video/123','00:30:00',0);
  store.setSettings({likesThreshold:'33000',commentsThreshold:'350',feishuWebhook:'https://open.feishu.cn/open-apis/bot/v2/hook/demo'});
  let round=0; const sent=[];
  const collector={collect:async()=>round++===0
    ? {...result([]),likesDisplay:'3.2万',likesValue:32000,commentsDisplay:'343',commentsValue:343}
    : {...result([]),likesDisplay:'3.5万',likesValue:35000,commentsDisplay:'355',commentsValue:355}};
  const monitor=createMonitor({store,collector,sender:{send:async alert=>{sent.push(alert);}}});
  await monitor.checkVideo(video.id);
  await monitor.checkVideo(video.id);
  const thresholds=sent.filter(alert=>alert.kind.endsWith('_threshold'));
  assert.equal(thresholds.length,2);
  assert.equal(thresholds[0].payload.title,'作品');
  assert.equal(thresholds[0].payload.url,video.url);
  assert.equal(thresholds.find(alert=>alert.kind==='likes_threshold').payload.deltaSinceFirst,3000);
  assert.equal(thresholds.find(alert=>alert.kind==='comments_threshold').payload.deltaSinceFirst,12);
  store.close();
});

test('configured keywords match collected comments and queue a video-specific summary', async () => {
  const store=createStore(':memory:'); const video=store.addVideo('https://www.douyin.com/video/123','00:30:00',0);
  store.setSettings({keywords:'投诉、BUG'});
  const monitor=createMonitor({store,collector:{collect:async()=>result([C('1','这里有bug'),C('2','我要投诉'),C('3','普通评论')])},sender:{send:async()=>{}}});
  await monitor.checkVideo(video.id);
  const alerts=store.listAlerts().filter(alert=>alert.kind==='new_keyword');
  assert.equal(alerts.length,1);
  assert.deepEqual(alerts[0].payload.words.sort(),['BUG','投诉'].sort());
  assert.equal(alerts[0].payload.count,2);
  assert.equal(alerts[0].video_id,video.id);
  store.close();
});

test('failed Feishu send waits before next retry', async () => {
  const store=createStore(':memory:'); const video=store.addVideo('https://www.douyin.com/video/123','00:30:00');
  store.setSettings({feishuWebhook:'https://open.feishu.cn/open-apis/bot/v2/hook/demo'});
  store.queueAlert(video.id,'new_keyword',{title:'作品'});
  let calls=0; const monitor=createMonitor({store,collector:{collect:async()=>result([])},sender:{send:async()=>{calls++;throw new Error('断网')}},clock:()=>new Date('2026-10-24T00:00:00.000Z')});
  await monitor.deliverPending();await monitor.deliverPending();
  assert.equal(calls,1);
  assert.equal(store.listAlerts({pending:true}).length,1);
  store.close();
});

test('stopping a video during a check discards that in-flight result', async () => {
  const store=createStore(':memory:');const video=store.addVideo('https://www.douyin.com/video/123','00:30:00');
  let resolveCollect;const collector={collect:()=>new Promise(resolve=>{resolveCollect=resolve})};
  const monitor=createMonitor({store,collector,sender:{send:async()=>{}}});
  const pending=monitor.checkVideo(video.id);
  monitor.pause(video.id);
  resolveCollect(result([C('1','内容')]));
  await pending;
  assert.equal(store.countComments(video.id),0);
  assert.equal(store.getVideo(video.id).status,'已停止');
  store.close();
});

test('concurrency setting limits all overlapping ticks', async () => {
  const store=createStore(':memory:');for(let i=1;i<=3;i++)store.addVideo(`https://www.douyin.com/video/${i}`,'00:30:00',0);
  store.setSettings({concurrency:'1'});const pending=[];let calls=0;
  const monitor=createMonitor({store,collector:{collect:()=>new Promise(resolve=>{calls++;pending.push(resolve)})},sender:{send:async()=>{}}});
  const first=monitor.tick();const second=monitor.tick();
  assert.equal(calls,1);
  pending[0](result([]));await Promise.all([first,second]);store.close();
});

test('recovery scans beyond 100 and does not consume unfinished initial backfill cap', async () => {
  const store=createStore(':memory:');const video=store.addVideo('https://www.douyin.com/video/123','00:30:00',800);
  const comments=Array.from({length:500},(_,i)=>C(String(i),`评论 ${i}`));let requested=0;
  const monitor=createMonitor({store,collector:{collect:async(_,options)=>{requested=options.commentLimit;return result(comments)}},sender:{send:async()=>{}}});
  monitor.pause(video.id);monitor.resume(video.id);await monitor.checkVideo(video.id);
  assert.ok(requested>=500);
  assert.equal(store.countComments(video.id,'recovery'),500);
  assert.equal(store.getVideo(video.id).backfill_count,0);
  assert.equal(store.getVideo(video.id).backfillDone,false);
  store.close();
});
