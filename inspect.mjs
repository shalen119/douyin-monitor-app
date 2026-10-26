import { chromium } from 'playwright-core';
const context = await chromium.launchPersistentContext('./data/inspect-profile', { channel: 'msedge', headless: true, viewport: { width: 1440, height: 900 } });
const page = context.pages()[0] || await context.newPage();
const started=Date.now();
page.on('response', async response => { const url = response.url(); if (url.includes('/aweme/detail/')) { try { const json=await response.json(); const a=json.aweme_detail; console.log('DETAIL',Date.now()-started,JSON.stringify({status:json.status_code,desc:a?.desc,stats:a?.statistics,statistics:a?.statistics,author:a?.author?.nickname}).slice(0,500)); } catch(e){console.log('DETAIL_ERROR',e.message)} } if(url.includes('/comment/list/')){try{const json=await response.json(); console.log('COMMENTS',Date.now()-started,JSON.stringify({status:json.status_code,total:json.total,has_more:json.has_more,cursor:json.cursor,number:json.comments?.length}).slice(0,250));console.log('COMMENT_URL',url.slice(0,450));}catch(e){console.log('COMMENT_ERROR',e.message)}} });
try {
  await page.goto('https://www.douyin.com/video/7673152596441304358', { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(9000);
  console.log('TITLE', await page.title());
  console.log('URL', page.url());
  const body = await page.locator('body').innerText();
  const pos = body.indexOf('10个AI神器一次看完');
  console.log('FOCUS', body.slice(Math.max(0,pos-400),pos+1400));
  console.log('COMMENTDOM', await page.locator('[class*=comment]').count());
  console.log('SCROLLABLES', await page.evaluate(() => [...document.querySelectorAll('*')].filter(e=>e.scrollHeight>e.clientHeight+50&&e.clientHeight>100).map(e=>({tag:e.tagName,cls:e.className?.toString().slice(0,110),h:e.clientHeight,sh:e.scrollHeight})).slice(0,15)));
  const comment = page.getByText('这种东西以后会被模型内化的',{exact:true});
  console.log('COMMENT_HTML', (await comment.locator('..').evaluate(e=>e.outerHTML)).slice(0,1600));
  console.log('COUNT_HTML', await page.evaluate(()=>[...document.querySelectorAll('*')].filter(e=>e.children.length===0&&e.textContent?.trim()==='3.2万').slice(0,3).map(e=>({tag:e.tagName,cls:e.className,html:e.outerHTML,parent:e.parentElement?.tagName,pcls:e.parentElement?.className,ptxt:e.parentElement?.innerText?.slice(0,80)}))));
  for(let i=0;i<3;i++){await page.evaluate(()=>{const e=[...document.querySelectorAll('*')].filter(e=>e.scrollHeight>e.clientHeight+50&&e.clientHeight>100).find(e=>e.textContent?.includes('全部评论'));if(e)e.scrollTop=e.scrollHeight});await page.waitForTimeout(2000)}
} catch (e) { console.log('ERROR',e.message); }
await context.close();
