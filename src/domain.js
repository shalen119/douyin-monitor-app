export function normalizeVideoUrl(input) {
  const match = String(input ?? '').match(/https?:\/\/[^\s<>，。]+/i);
  if (!match) throw new Error('请输入抖音视频链接');
  let url;
  try { url = new URL(match[0]); } catch { throw new Error('请输入有效的抖音视频链接'); }
  if (!['douyin.com', 'www.douyin.com'].includes(url.hostname.toLowerCase())) throw new Error('只支持抖音官方视频链接');
  const id = url.pathname.match(/^\/video\/(\d+)/)?.[1];
  if (!id) throw new Error('请粘贴抖音视频页面链接');
  return `https://www.douyin.com/video/${id}`;
}

export async function resolveVideoUrl(input, fetcher = fetch) {
  const match = String(input ?? '').match(/https?:\/\/[^\s<>，。]+/i);
  if (!match) throw new Error('请输入抖音视频链接');
  const url = new URL(match[0]);
  if (['douyin.com','www.douyin.com'].includes(url.hostname.toLowerCase())) return normalizeVideoUrl(url.toString());
  if (url.hostname.toLowerCase() !== 'v.douyin.com') throw new Error('只支持抖音官方视频链接');
  if (url.protocol !== 'https:') throw new Error('抖音短链接须使用 HTTPS');
  const response = await fetcher(url.toString(), { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(12000) });
  return normalizeVideoUrl(response.url);
}

export function parseDisplayCount(raw) {
  const display = String(raw ?? '').trim();
  const cleaned = display.replace(/,/g, '');
  const match = cleaned.match(/^(\d+(?:\.\d+)?)(万|亿)?$/);
  if (!match) return { display, value: null, approximate: false };
  const multiplier = match[2] === '亿' ? 100000000 : match[2] === '万' ? 10000 : 1;
  return { display, value: Math.round(Number(match[1]) * multiplier), approximate: Boolean(match[2]) };
}

export function parseKeywords(text) {
  const seen = new Set();
  return String(text ?? '').split('、').map(word => word.trim()).filter(word => {
    const key = word.toLocaleLowerCase();
    if (!word || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function matchKeywords(comment, words) {
  const body = String(comment ?? '').toLocaleLowerCase();
  return words.filter(word => body.includes(word.toLocaleLowerCase()));
}

export function intervalMs(text) {
  const match = String(text ?? '').match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) throw new Error('检查间隔须为 HH:MM:SS');
  const [, h, m, s] = match.map(Number);
  if (m > 59 || s > 59) throw new Error('检查间隔须为 HH:MM:SS');
  const ms = (h * 3600 + m * 60 + s) * 1000;
  if (ms < 60000 || ms > 86400000) throw new Error('检查间隔须在 1 分钟至 24 小时之间');
  return ms;
}
