import { createHash } from 'node:crypto';
import { parseDisplayCount } from './domain.js';

export function extractDisplayedMetrics(bodyText, title) {
  const lines = String(bodyText ?? '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const needle = String(title ?? '').replace(/\s+/g, ' ').trim();
  const index = lines.findIndex(line => line.replace(/\s+/g, ' ') === needle);
  if (index < 0) return { likesDisplay: '', commentsDisplay: '' };
  const nearby = lines.slice(index + 1, index + 7);
  if (!nearby[0] || !/^\d[\d,.]*(?:万|亿)?$/.test(nearby[0]) || !nearby[1] || !/^\d[\d,.]*(?:万|亿)?$/.test(nearby[1]))
    return { likesDisplay: '', commentsDisplay: '' };
  return { likesDisplay: nearby[0], commentsDisplay: nearby[1] };
}

export function mapDetail(data, bodyText = '') {
  if (data?.status_code !== 0 || !data?.aweme_detail) throw new Error('视频详情未返回有效数据');
  const item = data.aweme_detail;
  const title = String(item.desc || item.title || '未命名视频').replace(/\s+/g, ' ').trim();
  const displayed = extractDisplayedMetrics(bodyText, title);
  const likesRaw = displayed.likesDisplay || (Number.isInteger(item.statistics?.digg_count) ? String(item.statistics.digg_count) : '');
  const commentsRaw = displayed.commentsDisplay || (Number.isInteger(item.statistics?.comment_count) ? String(item.statistics.comment_count) : '');
  return {
    title, likesDisplay: likesRaw, likesValue: parseDisplayCount(likesRaw).value,
    commentsDisplay: commentsRaw, commentsValue: parseDisplayCount(commentsRaw).value
  };
}

export function mapCommentBatch(data) {
  if (data?.status_code !== 0) throw new Error(`评论列表读取失败：${data?.status_code ?? '无响应'}`);
  return {
    total: Number.isInteger(data.total) ? data.total : null,
    hasMore: Boolean(data.has_more), cursor: Number(data.cursor || 0),
    comments: (data.comments || []).filter(item => item && typeof item.text === 'string').map(item => {
      const body = item.text.trim();
      const fingerprint = item.cid ? `douyin:${item.cid}` : `fingerprint:${createHash('sha256').update(`${item.user?.uid ?? ''}|${item.create_time ?? ''}|${body}`).digest('hex')}`;
      return { fingerprint, platformId: item.cid || null, body,
        author: String(item.user?.nickname || ''), publishedAt: item.create_time ? new Date(item.create_time * 1000).toISOString() : '' };
    })
  };
}

function findCommentScroller() {
  const elements = [...document.querySelectorAll('*')];
  const candidates = elements.filter(e => e.clientHeight > 150 && e.scrollHeight > e.clientHeight + 50 && e.textContent?.includes('全部评论'));
  candidates.sort((a,b) => a.clientHeight - b.clientHeight);
  const target = candidates[0];
  if (!target) return false;
  target.scrollTop = target.scrollHeight;
  return true;
}

export async function waitForInitialBatch(page, count, timeoutMs = 12000) {
  let elapsed = 0;
  while (count() === 0 && elapsed < timeoutMs) {
    await page.waitForTimeout(500);
    elapsed += 500;
  }
  return count() > 0;
}

export async function collectPage(context, url, options = {}) {
  const limit = Math.max(0, Math.min(Number(options.commentLimit ?? 50), 10000));
  const page = await context.newPage();
  options.onPage?.(page);
  const batches = [];
  let detail = null;
  let responseError = '';
  let collecting = true;
  const responseHandler = async response => {
    if (!collecting) return;
    const responseUrl = response.url();
    try {
      if (responseUrl.includes('/aweme/detail/')) detail = await response.json();
      if (responseUrl.includes('/comment/list/')) batches.push(mapCommentBatch(await response.json()));
    } catch (error) { responseError = String(error.message || error); }
  };
  page.on('response', responseHandler);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForFunction(() => document.body?.innerText?.includes('全部评论'), { timeout: 16000 }).catch(() => {});
    if (limit > 0) await waitForInitialBatch(page, () => batches.length);
    if (!detail) await page.waitForTimeout(2500);
    if (!detail) throw new Error('视频详情未加载，可能需要重新登录或页面限制访问');
    let stalled = 0;
    while (limit > 0 && batches.flatMap(batch => batch.comments).length < limit && batches.at(-1)?.hasMore && stalled < 3) {
      const before = batches.length;
      const moved = await page.evaluate(findCommentScroller);
      if (!moved) break;
      await page.waitForTimeout(1400);
      stalled = batches.length === before ? stalled + 1 : 0;
    }
    const bodyText = await page.locator('body').innerText();
    const stats = mapDetail(detail, bodyText);
    const seen = new Set();
    const comments = batches.flatMap(batch => batch.comments).filter(comment => {
      if (seen.has(comment.fingerprint)) return false;
      seen.add(comment.fingerprint); return true;
    }).slice(0,limit);
    const total = batches.at(-1)?.total ?? stats.commentsValue;
    return { ...stats, comments, observedCommentTotal: total,
      complete: !batches.at(-1)?.hasMore && total != null && comments.length >= total,
      hasMore: Boolean(batches.at(-1)?.hasMore),
      loginRequired: bodyText.includes('请先登录后发表评论') || bodyText.includes('登录后即可参与互动讨论'),
      note: responseError || (batches.length === 0 ? '未读取到评论列表' : batches.at(-1)?.hasMore ? `已达到本轮采集上限或页面未继续加载；已采 ${comments.length} 条，平台显示 ${total ?? '未知'} 条` : '评论列表可能不含未展开的回复') };
  } finally { collecting = false; page.off('response', responseHandler); }
}
