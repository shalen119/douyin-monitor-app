const CST_MS = 8 * 3600000;
const local = value => new Date(new Date(value).getTime() + CST_MS);
const fmt = date => date.toISOString().slice(0,10);
const month = date => date.toISOString().slice(0,7);

function weekStart(date) {
  const copy = new Date(Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()));
  const weekday = (copy.getUTCDay() + 6) % 7;
  copy.setUTCDate(copy.getUTCDate() - weekday);
  return copy;
}

function bucketKey(date, period) {
  const shifted = local(date);
  return period === 'month' ? month(shifted) : period === 'week' ? fmt(weekStart(shifted)) : fmt(shifted);
}

function makeBuckets(period, now) {
  const shifted = local(now);
  const n = period === 'month' ? 12 : period === 'week' ? 8 : 7;
  const buckets = [];
  for (let i=n-1;i>=0;i--) {
    let d;
    if (period === 'month') d = new Date(Date.UTC(shifted.getUTCFullYear(),shifted.getUTCMonth()-i,1));
    else if (period === 'week') { d=weekStart(shifted); d.setUTCDate(d.getUTCDate()-7*i); }
    else { d=new Date(Date.UTC(shifted.getUTCFullYear(),shifted.getUTCMonth(),shifted.getUTCDate()-i)); }
    buckets.push({ key: period==='month'?month(d):fmt(d), newComments:0, historicalCollected:0, hits:0, rematches:0 });
  }
  return buckets;
}

export function buildReport({videos,comments,observations,alerts=[],period='day',ids,now=new Date()}) {
  if (!['day','week','month'].includes(period)) throw new Error('统计周期无效');
  const selected = new Set(ids?.length ? ids.map(Number) : videos.map(video=>video.id));
  const selectedVideos = videos.filter(video=>selected.has(video.id));
  const selectedComments = comments.filter(comment=>selected.has(comment.video_id));
  const buckets = makeBuckets(period,now);
  const byKey = new Map(buckets.map(bucket=>[bucket.key,bucket]));
  for (const comment of selectedComments) {
    const bucket = byKey.get(bucketKey(comment.discovered_at,period));
    if (!bucket) continue;
    if (comment.source === 'historical') bucket.historicalCollected++;
    else bucket.newComments++;
    if (comment.matchedInitial ?? Boolean(comment.matchedWords?.length)) bucket.hits++;
  }
  for (const alert of alerts) {
    if (alert.kind !== 'rematch_keyword' || !selected.has(alert.video_id)) continue;
    const bucket=byKey.get(bucketKey(alert.created_at,period));
    if (bucket) bucket.rematches += alert.payload?.count || 0;
  }
  const periodStart = buckets[0].key;
  const changes = { likes:0, comments:0 };
  for (const video of selectedVideos) {
    const values = observations.filter(row=>row.video_id===video.id && bucketKey(row.observed_at,period)>=periodStart)
      .sort((a,b)=>a.observed_at.localeCompare(b.observed_at));
    if (values.length>1) {
      changes.likes += (values.at(-1).likes_value ?? 0) - (values[0].likes_value ?? 0);
      changes.comments += (values.at(-1).comments_value ?? 0) - (values[0].comments_value ?? 0);
    }
  }
  return { period, buckets, totals: {
    videos:selectedVideos.length, newComments:buckets.reduce((n,b)=>n+b.newComments,0),
    historicalCollected:buckets.reduce((n,b)=>n+b.historicalCollected,0),
    hits:buckets.reduce((n,b)=>n+b.hits,0), rematches:buckets.reduce((n,b)=>n+b.rematches,0),
    storedComments:selectedComments.length,
    likesValue:selectedVideos.reduce((n,v)=>n+(v.likes_value||0),0),
    likesApproximate:selectedVideos.some(v=>/[万亿]/.test(v.likes_display||'')),
    displayedCommentTotal:selectedVideos.reduce((n,v)=>n+(v.comments_value||0),0),
    likesChange:changes.likes, commentTotalChange:changes.comments
  } };
}
