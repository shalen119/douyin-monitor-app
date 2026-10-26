import http from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from './store.js';
import { createBrowser } from './browser.js';
import { createMonitor } from './monitor.js';
import { feishuSender, validateWebhook } from './feishu.js';
import { resolveVideoUrl, intervalMs, parseKeywords } from './domain.js';
import { buildReport } from './report.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicDir = path.join(root,'public');
const startedAt = new Date().toISOString();

class BadRequest extends Error { status = 400; }
const bad = message => { throw new BadRequest(message); };

async function readJson(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/json')) bad('请求须使用 JSON');
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (text.length > 1048576) bad('请求内容过大');
  }
  try { return text ? JSON.parse(text) : {}; } catch { bad('JSON 格式无效'); }
}

function json(res, value, code = 200) {
  res.writeHead(code, { 'content-type':'application/json; charset=utf-8', 'cache-control':'no-store', 'x-content-type-options':'nosniff' });
  res.end(JSON.stringify(value));
}

function safeSettings(settings) {
  const { feishuWebhook, feishuSecret, ...rest } = settings;
  return { ...rest, feishuConfigured:Boolean(feishuWebhook), feishuSigningConfigured:Boolean(feishuSecret) };
}

function validateSettings(input) {
  const allowed = ['interval','backfillLimit','keywords','likesThreshold','commentsThreshold','feishuWebhook','feishuSecret','concurrency'];
  const patch = Object.fromEntries(Object.entries(input).filter(([key]) => allowed.includes(key)));
  if ('interval' in patch) intervalMs(patch.interval);
  if ('backfillLimit' in patch && (!Number.isInteger(Number(patch.backfillLimit)) || Number(patch.backfillLimit)<0 || Number(patch.backfillLimit)>10000)) bad('历史补采上限须为 0–10000');
  if ('keywords' in patch) {
    const words = parseKeywords(patch.keywords);
    if (words.length>100 || words.some(word=>word.length>50)) bad('命中词最多 100 个，每词最多 50 字');
    patch.keywords = words.join('、');
  }
  for (const key of ['likesThreshold','commentsThreshold']) if (key in patch && patch[key] !== '') {
    if (!Number.isSafeInteger(Number(patch[key])) || Number(patch[key])<0) bad('阈值须为非负整数');
  }
  if ('concurrency' in patch && (!Number.isInteger(Number(patch.concurrency)) || Number(patch.concurrency)<1 || Number(patch.concurrency)>4)) bad('并发数须为 1–4');
  if ('feishuWebhook' in patch) patch.feishuWebhook = validateWebhook(patch.feishuWebhook);
  if ('feishuSecret' in patch && String(patch.feishuSecret).length>500) bad('飞书签名密钥过长');
  return patch;
}

function report(store, period, ids) {
  return buildReport({
    videos:store.listVideos(), comments:store.listComments(null,{limit:100000}),
    observations:store.listObservationsAll(),alerts:store.listAlerts({limit:10000}),
    period, ids
  });
}

export function createApp({store,monitor,browser,staticDir=publicDir}) {
  return http.createServer(async (req,res) => {
    const url = new URL(req.url,'http://127.0.0.1');
    const route = url.pathname;
    try {
      if (req.method === 'GET' && ['/','/app.css','/polish.css','/app.js'].includes(route)) {
        const filename = route === '/' ? 'index.html' : route.slice(1);
        const content = await readFile(path.join(staticDir,filename));
        const type = filename.endsWith('.html') ? 'text/html' : filename.endsWith('.css') ? 'text/css' : 'text/javascript';
        res.writeHead(200,{'content-type':`${type}; charset=utf-8`,'cache-control':'no-store','x-content-type-options':'nosniff'});
        res.end(content); return;
      }
      if (req.method === 'GET' && route === '/api/state') {
        const videos = store.listVideos().map(video => {
          const first = store.getFirstObservation(video.id);
          const baseline = first ? { likesDisplay:first.likes_display,commentsDisplay:first.comments_display,
            likesValue:first.likes_value,commentsValue:first.comments_value } : null;
          const changeSinceFirst = first ? {
            likes:video.likes_value == null || first.likes_value == null ? null : video.likes_value-first.likes_value,
            comments:video.comments_value == null || first.comments_value == null ? null : video.comments_value-first.comments_value,
            likesApproximate:/[万亿]/.test(`${first.likes_display}${video.likes_display}`),
            commentsApproximate:/[万亿]/.test(`${first.comments_display}${video.comments_display}`)
          } : null;
          return {...video,storedComments:store.countComments(video.id),baseline,changeSinceFirst};
        });
        const today = report(store,'day');
        const roundComments = store.listComments(null,{limit:100000}).filter(comment =>
          comment.source !== 'historical' && videos.some(video => video.id===comment.video_id && video.last_check===comment.discovered_at));
        const sources = videos.map(video => ({videoId:video.id,title:video.title||video.url,url:video.url,
          comments:roundComments.filter(comment=>comment.video_id===video.id)})).filter(item=>item.comments.length);
        return json(res,{videos,alerts:store.listAlerts({limit:50}),settings:safeSettings(store.getSettings()),today,
          lastRound:{count:roundComments.length,sources},runtime:{startedAt,activeVideos:videos.filter(v=>!v.paused).length}});
      }
      if (req.method === 'GET' && route === '/api/report') {
        const ids=url.searchParams.get('ids')?.split(',').filter(Boolean).map(Number);
        return json(res,report(store,url.searchParams.get('period') || 'day',ids));
      }
      if (req.method === 'GET' && route === '/api/login/status') return json(res,await browser.status());
      if (req.method === 'POST' && route === '/api/login/open') return json(res,await browser.openLogin());
      if (req.method === 'POST' && route === '/api/login/verify') {
        const status=await browser.status();
        if (status.sessionSaved) for (const video of store.listVideos().filter(v=>v.status==='登录失效' && !v.paused))
          store.updateVideo(video.id,{status:'待检查',next_check:new Date().toISOString(),error:''});
        return json(res,status);
      }
      if (req.method === 'POST' && route === '/api/videos') {
        const input=await readJson(req);
        const lines=Array.isArray(input.links)?input.links:String(input.links || '').split(/\r?\n/).filter(Boolean);
        if (!lines.length || lines.length>100) bad('每次添加 1–100 条视频链接');
        const settings=store.getSettings();
        const interval=input.interval || settings.interval; intervalMs(interval);
        const limit=input.backfillLimit === undefined ? Number(settings.backfillLimit) : Number(input.backfillLimit);
        const added=[]; const duplicates=[]; const errors=[];
        for (const line of lines) {
          try {
            const canonical=await resolveVideoUrl(line);
            if (store.getVideoByUrl(canonical)) { duplicates.push(canonical); continue; }
            added.push(store.addVideo(canonical,interval,limit));
          } catch (error) { errors.push({input:String(line).slice(0,150),message:String(error.message || error)}); }
        }
        return json(res,{added,duplicates,errors});
      }
      if (req.method === 'DELETE' && route === '/api/videos') {
        const input=await readJson(req);
        if (!Array.isArray(input.ids) || !input.ids.length || input.ids.some(id=>!Number.isSafeInteger(Number(id)))) bad('请选择要删除的视频');
        const ids=[...new Set(input.ids.map(Number))]; store.deleteVideos(ids);
        return json(res,{deleted:ids.length});
      }
      if (req.method === 'PUT' && route === '/api/videos/interval') {
        const input=await readJson(req); intervalMs(input.interval);
        if (!Array.isArray(input.ids) || !input.ids.length) bad('请选择视频');
        for (const id of input.ids) store.updateVideo(Number(id),{interval:input.interval,next_check:new Date(Date.now()+intervalMs(input.interval)).toISOString()});
        return json(res,{updated:input.ids.length});
      }
      const videoAction=route.match(/^\/api\/videos\/(\d+)\/(pause|resume|check|comments)$/);
      if (videoAction) {
        const id=Number(videoAction[1]); const action=videoAction[2];
        if (!store.getVideo(id)) bad('视频不存在');
        if (req.method==='GET' && action==='comments') return json(res,{comments:store.listComments(id,{limit:10000})});
        if (req.method==='POST' && action==='pause') return json(res,{video:monitor.pause(id)});
        if (req.method==='POST' && action==='resume') return json(res,{video:monitor.resume(id)});
        if (req.method==='POST' && action==='check') { void monitor.checkVideo(id); return json(res,{started:true},202); }
      }
      if (req.method === 'POST' && route === '/api/check-all') { void monitor.tick(); return json(res,{started:true},202); }
      if (req.method === 'PUT' && route === '/api/settings') {
        const input=await readJson(req); const patch=validateSettings(input);
        const before=store.getSettings(); const settings=store.setSettings(patch);
        if ('interval' in patch && input.applyIntervalToAll) for (const video of store.listVideos()) store.updateVideo(video.id,{interval:settings.interval});
        const rematch='keywords' in patch && settings.keywords!==before.keywords ? monitor.rematch() : null;
        if (settings.likesThreshold!==before.likesThreshold || settings.commentsThreshold!==before.commentsThreshold) monitor.recheckThresholds();
        return json(res,{settings:safeSettings(settings),rematch});
      }
      if (req.method === 'POST' && route === '/api/feishu/test') {
        const settings=store.getSettings();
        if (!settings.feishuWebhook) bad('请先保存飞书 Webhook');
        const alert=store.queueAlert(null,'test',{title:'连接测试',reason:'飞书连接测试',url:'本地监测服务'});
        await monitor.deliverPending();
        const delivered=store.getAlert(alert.id);
        if (!delivered.delivered_at) return json(res,{sent:false,error:delivered.last_error},502);
        return json(res,{sent:true});
      }
      if (req.method === 'GET' && route === '/api/alerts') {
        const limit=Math.min(200,Math.max(1,Number(url.searchParams.get('limit'))||100));
        const date=url.searchParams.get('date');
        if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) bad('日期格式须为 YYYY-MM-DD');
        const from=date?new Date(`${date}T00:00:00+08:00`).toISOString():undefined;
        const to=from?new Date(new Date(from).getTime()+86400000).toISOString():undefined;
        const page=store.listAlerts({limit:limit+1,beforeId:url.searchParams.get('before'),videoId:url.searchParams.get('videoId'),kind:url.searchParams.get('kind'),from,to});
        return json(res,{alerts:page.slice(0,limit),nextBefore:page.length>limit?page[limit-1].id:null});
      }
      const alertMatch=route.match(/^\/api\/alerts\/(\d+)$/);
      if (req.method==='GET' && alertMatch) {
        const alert=store.getAlert(Number(alertMatch[1])); if (!alert) bad('提醒不存在');
        return json(res,{alert,comments:store.getCommentsByIds(alert.payload.commentIds || [])});
      }
      json(res,{error:'路径不存在'},404);
    } catch (error) {
      const status=error.status || (error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 400);
      json(res,{error:String(error.message || error)},status);
    }
  });
}

if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const dataDir=path.join(root,'data');
  await mkdir(dataDir,{recursive:true});
  const store=createStore(path.join(dataDir,'monitor.sqlite'));
  const browser=createBrowser(path.join(dataDir,'browser-profile'));
  const monitor=createMonitor({store,collector:browser,sender:feishuSender});
  const app=createApp({store,monitor,browser});
  const port=Number(process.env.PORT || 4318);
  app.listen(port,'127.0.0.1',()=>console.log(`抖音监测已启动：http://127.0.0.1:${port}`));
  monitor.start();
  const shutdown=async()=>{ monitor.stop(); app.close(); await browser.close(); store.close(); process.exit(0); };
  process.on('SIGINT',()=>{void shutdown();});
  process.on('SIGTERM',()=>{void shutdown();});
}
