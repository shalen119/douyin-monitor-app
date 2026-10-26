import { createHmac } from 'node:crypto';
const HOOK_PATH = /^\/open-apis\/bot\/v2\/hook\/[\w-]+$/;

export function validateWebhook(input) {
  if (!input) return '';
  let url;
  try { url = new URL(input); } catch { throw new Error('飞书 Webhook 地址无效'); }
  if (url.protocol !== 'https:' || !['open.feishu.cn','open.larksuite.com'].includes(url.hostname) || !HOOK_PATH.test(url.pathname))
    throw new Error('请输入飞书群自定义机器人的 HTTPS Webhook');
  return url.toString();
}

export function formatAlert(alert) {
  const p = alert.payload || {};
  const lines = [`抖音舆情提醒 · ${p.title || '监测视频'}`, `视频：${p.url || ''}`];
  if (p.reason) lines.push(`原因：${p.reason}`);
  if (p.likesDisplay) lines.push(`点赞量：${p.likesDisplay}`);
  if (p.commentsDisplay) lines.push(`评论总数：${p.commentsDisplay}`);
  if (alert.kind === 'likes_threshold' || alert.kind === 'comments_threshold') {
    const label=alert.kind === 'likes_threshold' ? '点赞量' : '评论总数';
    if (p.baselineDisplay) lines.push(`${label}首次采集：${p.baselineDisplay}`);
    if (Number.isFinite(p.deltaSinceFirst)) lines.push(`${label}较首次采集：${p.approximate?'约':''}${p.deltaSinceFirst>=0?'+':''}${p.deltaSinceFirst.toLocaleString('zh-CN')}`);
  }
  if (Number.isInteger(p.collected)) lines.push(`本批采集：${p.collected} 条；命中：${p.count || 0} 条`);
  if (Array.isArray(p.words) && p.words.length) lines.push(`命中词：${p.words.join('、')}`);
  if (Array.isArray(p.excerpts)) for (const excerpt of p.excerpts.slice(0,3)) lines.push(`评论：${String(excerpt).slice(0,150)}`);
  lines.push(`时间：${new Date(alert.created_at).toLocaleString('zh-CN',{hour12:false})}`);
  return lines.join('\n');
}

export function buildFeishuBody(alert, secret = '', seconds = Math.floor(Date.now()/1000)) {
  const body={msg_type:'text',content:{text:formatAlert(alert)}};
  if (secret) {
    body.timestamp=String(seconds);
    body.sign=createHmac('sha256',`${body.timestamp}\n${secret}`).update('').digest('base64');
  }
  return body;
}

export const feishuSender = {
  async send(alert, webhook, secret = '') {
    const url = validateWebhook(webhook);
    if (!url) throw new Error('尚未配置飞书 Webhook');
    const response = await fetch(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildFeishuBody(alert,secret)),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`飞书 HTTP ${response.status}`);
    const data = await response.json();
    if (data.code !== 0 && data.StatusCode !== 0) throw new Error(`飞书发送失败：${data.msg || data.StatusMessage || data.code}`);
    return true;
  }
};
