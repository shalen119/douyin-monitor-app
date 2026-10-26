import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { createStore } from '../src/store.js';
import { createMonitor } from '../src/monitor.js';
import { createApp } from '../src/server.js';

test('approved sidebar, add-video flow and card detail work in browser', async () => {
  const store=createStore(':memory:');
  const monitor=createMonitor({store,collector:{collect:async()=>({})},sender:{send:async()=>{}}});
  const server=createApp({store,monitor,browser:{status:async()=>({sessionSaved:false}),openLogin:async()=>({opened:true})}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage();
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    for (const id of ['dashboard','videos','rules','hits','reports','status','settings'])
      assert.equal(await page.locator(`#nav-${id}`).count(),1);
    await page.locator('#nav-videos').click();
    await page.locator('#video-links').fill('https://www.douyin.com/video/123');
    await page.locator('#add-video').click();
    await page.locator('#video-rows a[href="https://www.douyin.com/video/123"]').waitFor();
    assert.equal(await page.locator('.video-check-v6').count(),1);
    const width=await page.locator('.video-check-v6').evaluate(el=>el.getBoundingClientRect().width);
    assert.ok(width>=28);
    await page.locator('#nav-dashboard').click();
    await page.locator('#card-new-comments').click();
    assert.equal(await page.locator('#card-modal').isVisible(),true);
    await page.locator('#modal-close').click();
    const old=store.queueAlert(store.listVideos()[0].id,'historical_keyword',{title:'旧提醒',reason:'旧'});
    store.raw.prepare('UPDATE alerts SET created_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z',old.id);
    store.queueAlert(null,'test',{title:'连接测试',reason:'测试'});
    await page.reload();
    await page.locator('#card-alerts').click();
    assert.equal(await page.locator('#dash-alerts').textContent(),'0');
    assert.equal(await page.locator('#modal-body').getByText('旧提醒').count(),0);
    await page.locator('#modal-close').click();
    await page.locator('#nav-hits').click();
    await page.locator('#hit-date-filter').fill('2020-01-01');
    await page.locator('#hit-rows').getByText('旧提醒').waitFor();
    store.updateVideo(store.listVideos()[0].id,{likes_display:'3.2万',likes_value:32000});
    await page.reload();
    assert.equal(await page.locator('#dash-likes').textContent(),'3.2万');
    store.addObservation(store.listVideos()[0].id,{likesDisplay:'3.2万',likesValue:32000,commentsDisplay:'343',commentsValue:343,observedAt:'2026-10-24T00:00:00.000Z'});
    store.updateVideo(store.listVideos()[0].id,{likes_display:'3.5万',likes_value:35000,comments_display:'355',comments_value:355});
    await page.reload();
    await page.locator('#nav-videos').click();
    await page.locator('#video-rows').getByText('较首次约 +3,000').waitFor();
    await page.locator('#video-rows').getByText('较首次 +12').waitFor();
    await page.locator('#nav-settings').click();
    await page.locator('#setting-keywords').fill('投诉、故障');
    await page.locator('[data-apply-setting="keywords"]').click();
    await page.locator('#toast').getByText('配置已保存').waitFor();
    assert.equal(store.getSettings().keywords,'投诉、故障');
    await page.waitForTimeout(1700);
    assert.equal(await page.locator('#toast').isVisible(),false);
    await page.locator('[data-apply-setting="keywords"]').click();
    await page.locator('#toast-close').click();
    assert.equal(await page.locator('#toast').isVisible(),false);
  } finally { await browser.close(); server.close(); store.close(); }
});

test('narrow monitor keeps select-all and video actions visible', async () => {
  const store=createStore(':memory:');
  const monitor=createMonitor({store,collector:{collect:async()=>({})},sender:{send:async()=>{}}});
  const server=createApp({store,monitor,browser:{status:async()=>({sessionSaved:false}),openLogin:async()=>({opened:true})}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:900,height:800}});
  try {
    store.addVideo('https://www.douyin.com/video/123','00:30:00');
    store.addVideo('https://www.douyin.com/video/456','00:30:00');
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator('#nav-videos').click();
    assert.equal(await page.locator('.selection-toolbar #select-all').isVisible(),true);
    assert.ok(await page.locator('#select-all').evaluate(el=>el.getBoundingClientRect().width)>=28);
    await page.locator('#select-all').check();
    assert.equal(await page.locator('#selected-count').textContent(),'已选 2 条');
    assert.equal(await page.locator('.video-check-v6:checked').count(),2);
    await page.locator('.video-check-v6').first().uncheck();
    assert.equal(await page.locator('#selected-count').textContent(),'已选 1 条');
    assert.equal(await page.locator('#select-all').evaluate(el=>el.indeterminate),true);
    const layout=await page.evaluate(()=>({body:document.body.scrollWidth,viewport:window.innerWidth,
      actions:[...document.querySelectorAll('#video-rows [data-action]')].map(el=>el.getBoundingClientRect().right)}));
    assert.ok(layout.body<=layout.viewport,`page scrolls horizontally: ${JSON.stringify(layout)}`);
    assert.ok(layout.actions.every(right=>right<=layout.viewport),`video actions offscreen: ${JSON.stringify(layout)}`);
    await page.setViewportSize({width:600,height:800});
    const mobile=await page.evaluate(()=>({body:document.body.scrollWidth,viewport:window.innerWidth,
      actions:[...document.querySelectorAll('#video-rows [data-action]')].map(el=>el.getBoundingClientRect().right)}));
    assert.ok(mobile.body<=mobile.viewport,`mobile page scrolls horizontally: ${JSON.stringify(mobile)}`);
    assert.ok(mobile.actions.every(right=>right<=mobile.viewport),`mobile actions offscreen: ${JSON.stringify(mobile)}`);
  } finally {await browser.close();server.close();store.close();}
});

test('polished navigation and empty report keep record details accessible', async () => {
  const store=createStore(':memory:');
  const monitor=createMonitor({store,collector:{collect:async()=>({})},sender:{send:async()=>{}}});
  const server=createApp({store,monitor,browser:{status:async()=>({sessionSaved:false}),openLogin:async()=>({opened:true})}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:900,height:800}});
  try {
    const video=store.addVideo('https://www.douyin.com/video/123','00:30:00');
    store.queueAlert(video.id,'comments_threshold',{title:'测试作品',url:video.url,reason:'评论总数达到 10'});
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(await page.locator('.side .nav-icon svg').count(),7);
    const nextCheckWidth=await page.locator('#dashboard-videos tr').first().locator('td').nth(2).evaluate(el=>el.getBoundingClientRect().width);
    assert.ok(nextCheckWidth>=70,`dashboard next-check text column too narrow: ${nextCheckWidth}`);
    await page.locator('#nav-reports').click();
    await page.locator('#report-chart').getByText('本期暂无新增评论').waitFor();
    await page.locator('#nav-hits').click();
    await page.locator('#hit-rows [data-alert]').first().click();
    await page.getByText('评论总数达到 10').last().waitFor();
  } finally {await browser.close();server.close();store.close();}
});

test('report video picker filters one, many, and all videos', async () => {
  const store=createStore(':memory:');
  const monitor=createMonitor({store,collector:{collect:async()=>({})},sender:{send:async()=>{}}});
  const server=createApp({store,monitor,browser:{status:async()=>({sessionSaved:false}),openLogin:async()=>({opened:true})}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:900,height:800}});
  try {
    store.addVideo('https://www.douyin.com/video/123','00:30:00');
    store.addVideo('https://www.douyin.com/video/456','00:30:00');
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.locator('#nav-reports').click();
    await page.locator('#report-videos-toggle').click();
    await page.locator('#report-videos-menu input').first().check();
    await page.locator('#report-totals').getByText('监测视频：1 条').waitFor();
    await page.locator('#report-videos-menu input').last().check();
    await page.locator('#report-totals').getByText('监测视频：2 条').waitFor();
    await page.locator('#report-videos-menu input').first().uncheck();
    await page.locator('#report-totals').getByText('监测视频：1 条').waitFor();
    await page.locator('#report-videos-menu input').last().uncheck();
    await page.locator('#report-videos-toggle').getByText('全部视频').waitFor();
    await page.locator('#report-totals').getByText('监测视频：2 条').waitFor();
    let releaseOlder;
    const olderGate=new Promise(resolve=>{releaseOlder=resolve;});
    let olderHeld=false;
    let latestSent;
    const latestGate=new Promise(resolve=>{latestSent=resolve;});
    await page.route('**/api/report*',async route=>{
      const ids=new URL(route.request().url()).searchParams.get('ids');
      if (ids==='2' && !olderHeld) {
        olderHeld=true;
        const response=await route.fetch();
        await olderGate;
        await route.fulfill({response});
      } else if (ids==='2,1') {
        await route.continue();
        latestSent();
      } else await route.continue();
    });
    await page.locator('#report-videos-menu input').first().check();
    await page.locator('#report-videos-menu input').last().check();
    await latestGate;
    await page.locator('#report-totals').getByText('监测视频：2 条').waitFor();
    releaseOlder();
    await page.waitForTimeout(200);
    assert.equal(await page.locator('#report-totals').getByText('监测视频：2 条').count(),1);
  } finally {await browser.close();server.close();store.close();}
});
