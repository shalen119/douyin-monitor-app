import { intervalMs, parseKeywords, matchKeywords } from './domain.js';

function alertPayload(video, reason, comments = [], collected) {
  const words = [...new Set(comments.flatMap(comment => comment.matchedWords || []))];
  return { title: video.title, url: video.url, reason, count: comments.length, words,
    commentIds: comments.map(comment => comment.id), excerpts: comments.slice(0,3).map(comment => comment.body),
    collected, likesDisplay: video.likes_display, commentsDisplay: video.comments_display };
}

export function createMonitor({ store, collector, sender, clock = () => new Date() }) {
  const active = new Set();
  let timer;
  let delivering = false;
  const now = () => clock().toISOString();

  async function deliverPending() {
    if (delivering) return;
    const settings = store.getSettings();
    const webhook = settings.feishuWebhook;
    if (!webhook) return;
    delivering = true;
    try {
      for (const alert of store.listAlerts({ due: true, now:now(), limit: 100 }).reverse()) {
        try { await sender.send(alert, webhook, settings.feishuSecret); store.markAlertSent(alert.id, now()); }
        catch (error) { store.markAlertFailed(alert.id, error.message || error, now()); }
      }
    } finally { delivering = false; }
  }

  function thresholdAlerts(video, settings) {
    for (const [kind, raw, value] of [
      ['likes', settings.likesThreshold, video.likes_value], ['comments', settings.commentsThreshold, video.comments_value]
    ]) {
      if (!raw) continue;
      const threshold = Number(raw);
      if (!Number.isSafeInteger(threshold) || threshold < 0 || value == null) continue;
      if (value >= threshold && store.getThresholdState(video.id, kind) !== threshold) {
        const first=store.getFirstObservation(video.id);
        const firstValue=first?.[kind === 'likes' ? 'likes_value' : 'comments_value'];
        const baselineDisplay=first?.[kind === 'likes' ? 'likes_display' : 'comments_display'];
        const currentDisplay=kind === 'likes' ? video.likes_display : video.comments_display;
        store.queueAlert(video.id, `${kind}_threshold`, {
          ...alertPayload(video, `${kind === 'likes' ? '点赞量' : '评论总数'}达到 ${threshold}`),
          baselineDisplay:baselineDisplay || null,
          deltaSinceFirst:firstValue == null ? null : value-firstValue,
          approximate:/[万亿]/.test(`${baselineDisplay || ''}${currentDisplay || ''}`)
        });
        store.setThresholdState(video.id, kind, threshold);
      }
    }
  }

  async function checkVideo(id) {
    const video = store.getVideo(id);
    if (!video || video.paused || active.has(id)) return null;
    active.add(id);
    try {
      const settings = store.getSettings();
      const wasRecovery = video.status === '恢复待补采';
      const wasBackfill = !video.backfillDone && !wasRecovery;
      const remaining = Math.max(0, video.backfill_limit - video.backfill_count);
      const limit = wasRecovery ? 10000 : wasBackfill ? Math.min(10000, Math.max(remaining + video.backfill_count, 5)) : 100;
      const snapshot = await collector.collect(video, { commentLimit: limit });
      const current = store.getVideo(id);
      if (!current || current.paused) return { videoId:id, skipped: current?.paused ? 'paused' : 'deleted' };
      const observedAt = now();
      store.addObservation(id, { ...snapshot, observedAt });
      let updated = store.updateVideo(id, {
        title: snapshot.title || video.title, likes_display: snapshot.likesDisplay || '', likes_value: snapshot.likesValue,
        comments_display: snapshot.commentsDisplay || '', comments_value: snapshot.commentsValue,
        last_check: observedAt, error: snapshot.note || ''
      });
      if (snapshot.loginRequired) {
        store.updateVideo(id, { status: '登录失效', error: '抖音页面提示需要登录；请在设置中登录后重试。', next_check: null });
        return { loginRequired: true, videoId: id };
      }
      const words = parseKeywords(settings.keywords);
      const source = wasRecovery ? 'recovery' : wasBackfill ? 'historical' : 'new';
      const added = [];
      for (const comment of snapshot.comments || []) {
        if (wasBackfill && added.length >= remaining) break;
        const matchedWords = matchKeywords(comment.body, words);
        const saved = store.addComment({ ...comment, videoId: id, source, discoveredAt: observedAt, matchedWords });
        if (saved.inserted) added.push({ ...saved.comment, matchedWords });
      }
      const hits = added.filter(comment => comment.matchedWords.length);
      if (wasRecovery && hits.length) store.queueAlert(id, 'recovery_keyword', alertPayload(updated, '恢复采集补采命中汇总', hits, added.length));
      if (!wasBackfill && !wasRecovery && hits.length) store.queueAlert(id, 'new_keyword', alertPayload(updated, '本轮新评论命中汇总', hits, added.length));
      const count = video.backfill_count + (wasBackfill ? added.length : 0);
      const backfillDone = wasBackfill && (count >= video.backfill_limit || !snapshot.hasMore);
      updated = store.updateVideo(id, {
        backfill_count: count, backfill_done: wasBackfill ? Number(backfillDone) : Number(video.backfillDone),
        status: snapshot.complete ? '正常' : '部分评论未读取',
        next_check: new Date(clock().getTime() + intervalMs(video.interval)).toISOString(), failures: 0,
        error: snapshot.note || ''
      });
      if (wasBackfill && backfillDone) {
        const historicalHits = store.listComments(id, { source: 'historical', limit: 10000 }).filter(comment => comment.matchedWords.length);
        if (historicalHits.length) store.queueAlert(id, 'historical_keyword', alertPayload(updated, '首次历史评论补采命中汇总', historicalHits, count));
      }
      thresholdAlerts(updated, settings);
      await deliverPending();
      return { videoId: id, added: added.length, hits: hits.length, backfillDone: updated.backfillDone, complete: snapshot.complete };
    } catch (error) {
      const latest = store.getVideo(id);
      const failures = (latest?.failures || 0) + 1;
      const wait = Math.min(3600000, 60000 * 2 ** Math.min(failures - 1, 6));
      store.updateVideo(id, { status: '待重试', error: String(error.message || error), failures,
        next_check: new Date(clock().getTime() + wait).toISOString() });
      return { videoId: id, error: String(error.message || error) };
    } finally { active.delete(id); }
  }

  function rematch() {
    const words = parseKeywords(store.getSettings().keywords);
    const grouped = new Map();
    for (const comment of store.listComments(null, { limit: 100000 })) {
      const next = matchKeywords(comment.body, words);
      if (!comment.matchedWords.length && next.length) {
        if (!grouped.has(comment.video_id)) grouped.set(comment.video_id, []);
        grouped.get(comment.video_id).push({ ...comment, matchedWords: next });
      }
      store.updateCommentMatch(comment.id, next, comment.alerted);
    }
    for (const [id, comments] of grouped) {
      const video = store.getVideo(id);
      if (video) store.queueAlert(id, 'rematch_keyword', alertPayload(video, '词库更新重匹配新增命中', comments, comments.length));
    }
    void deliverPending();
    return { matched: [...grouped.values()].reduce((n, comments) => n + comments.length, 0) };
  }

  function recheckThresholds() {
    const settings=store.getSettings();
    for (const video of store.listVideos()) thresholdAlerts(video,settings);
    void deliverPending();
  }

  async function tick() {
    const due = store.listVideos().filter(video => !video.paused && video.status !== '登录失效' && (!video.next_check || video.next_check <= now()));
    const max = Math.min(4, Math.max(1, Number(store.getSettings().concurrency) || 2));
    const selected = due.filter(video => !active.has(video.id)).slice(0, Math.max(0,max-active.size));
    const results = await Promise.all(selected.map(video => checkVideo(video.id)));
    await deliverPending();
    return results;
  }

  return {
    checkVideo, tick, rematch, recheckThresholds, deliverPending,
    pause(id) { return store.updateVideo(id, { paused: 1, status: '已停止', next_check: null }); },
    resume(id) { return store.updateVideo(id, { paused: 0, status: '恢复待补采', next_check: now() }); },
    start() { if (!timer) { timer = setInterval(() => { void tick(); }, 10000); timer.unref?.(); void tick(); } },
    stop() { if (timer) clearInterval(timer); timer = null; }
  };
}
