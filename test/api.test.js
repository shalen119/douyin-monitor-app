import test from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/store.js';
import { createMonitor } from '../src/monitor.js';
import { createApp } from '../src/server.js';

test('local API adds, pauses, resumes and deletes a video', async () => {
  const store=createStore(':memory:');
  const monitor=createMonitor({store,collector:{collect:async()=>({})},sender:{send:async()=>{}}});
  const server=createApp({store,monitor,browser:{status:async()=>({sessionSaved:false}),openLogin:async()=>({opened:true})}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  try {
    let response=await post('/api/videos',{links:'https://www.douyin.com/video/123'});
    assert.equal(response.status,200); const added=await response.json(); assert.equal(added.added.length,1);
    const id=added.added[0].id;
    response=await post(`/api/videos/${id}/pause`,{}); assert.equal((await response.json()).video.paused,true);
    response=await post(`/api/videos/${id}/resume`,{}); assert.equal((await response.json()).video.paused,false);
    response=await fetch(base+'/api/state'); assert.equal((await response.json()).videos.length,1);
    response=await fetch(base+'/api/videos',{method:'DELETE',headers:{'content-type':'application/json'},body:JSON.stringify({ids:[id]})});
    assert.equal(response.status,200); assert.equal(store.listVideos().length,0);
  } finally {server.close();store.close();}
});

test('settings reject malformed thresholds and do not expose webhook in state', async () => {
  const store=createStore(':memory:'); const monitor=createMonitor({store,collector:{collect:async()=>({})},sender:{send:async()=>{}}});
  const server=createApp({store,monitor,browser:{status:async()=>({sessionSaved:false}),openLogin:async()=>({opened:true})}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const bad=await fetch(base+'/api/settings',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({likesThreshold:'oops'})});
    assert.equal(bad.status,400);
    const good=await fetch(base+'/api/settings',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({feishuWebhook:'https://open.feishu.cn/open-apis/bot/v2/hook/demo'})});
    assert.equal(good.status,200);
    const state=await (await fetch(base+'/api/state')).json();
    assert.equal(state.settings.feishuConfigured,true);
    assert.equal(JSON.stringify(state).includes('/hook/demo'),false);
  } finally {server.close();store.close();}
});

test('alert API paginates past dashboard limit and filters by date', async () => {
  const store=createStore(':memory:');const video=store.addVideo('https://www.douyin.com/video/123','00:30:00');
  for(let i=0;i<65;i++)store.queueAlert(video.id,'new_keyword',{count:1});
  const old=store.queueAlert(video.id,'new_keyword',{count:1});
  store.raw.prepare('UPDATE alerts SET created_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z',old.id);
  const monitor=createMonitor({store,collector:{collect:async()=>({})},sender:{send:async()=>{}}});
  const server=createApp({store,monitor,browser:{status:async()=>({}),openLogin:async()=>({})}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
  try {
    const first=await (await fetch(base+'/api/alerts?limit=50')).json();
    assert.equal(first.alerts.length,50);assert.ok(first.nextBefore);
    const second=await (await fetch(base+`/api/alerts?limit=50&before=${first.nextBefore}`)).json();
    assert.equal(second.alerts.length,16);
    const filtered=await (await fetch(base+'/api/alerts?date=2020-01-01')).json();
    assert.equal(filtered.alerts.length,1);assert.equal(filtered.alerts[0].id,old.id);
  } finally {server.close();store.close();}
});

test('video state compares likes and platform comment total with first collection', async () => {
  const store=createStore(':memory:');
  const video=store.addVideo('https://www.douyin.com/video/123','00:30:00');
  store.addObservation(video.id,{likesDisplay:'3.2万',likesValue:32000,commentsDisplay:'343',commentsValue:343,observedAt:'2026-10-24T00:00:00.000Z'});
  store.addObservation(video.id,{likesDisplay:'3.5万',likesValue:35000,commentsDisplay:'355',commentsValue:355,observedAt:'2026-10-24T01:00:00.000Z'});
  store.updateVideo(video.id,{likes_display:'3.5万',likes_value:35000,comments_display:'355',comments_value:355});
  const monitor=createMonitor({store,collector:{collect:async()=>({})},sender:{send:async()=>{}}});
  const server=createApp({store,monitor,browser:{status:async()=>({}),openLogin:async()=>({})}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const state=await (await fetch(`http://127.0.0.1:${server.address().port}/api/state`)).json();
    assert.deepEqual(state.videos[0].baseline,{likesDisplay:'3.2万',commentsDisplay:'343',likesValue:32000,commentsValue:343});
    assert.deepEqual(state.videos[0].changeSinceFirst,{likes:3000,comments:12,likesApproximate:true,commentsApproximate:false});
  } finally {server.close();store.close();}
});
