import { DatabaseSync } from 'node:sqlite';
import { intervalMs } from './domain.js';

const DEFAULTS = {
  interval: '00:30:00', backfillLimit: '200', keywords: '', likesThreshold: '', commentsThreshold: '', feishuWebhook: '', feishuSecret: '', concurrency: '2'
};

export function createStore(path) {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY, url TEXT NOT NULL UNIQUE, title TEXT NOT NULL DEFAULT '',
      paused INTEGER NOT NULL DEFAULT 0, interval TEXT NOT NULL, backfill_limit INTEGER NOT NULL DEFAULT 200,
      backfill_done INTEGER NOT NULL DEFAULT 0, backfill_count INTEGER NOT NULL DEFAULT 0,
      last_check TEXT, next_check TEXT, status TEXT NOT NULL DEFAULT '待检查', error TEXT NOT NULL DEFAULT '',
      failures INTEGER NOT NULL DEFAULT 0, likes_display TEXT NOT NULL DEFAULT '', likes_value INTEGER,
      comments_display TEXT NOT NULL DEFAULT '', comments_value INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY, video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL, platform_id TEXT, body TEXT NOT NULL, author TEXT NOT NULL DEFAULT '',
      published_at TEXT NOT NULL DEFAULT '', discovered_at TEXT NOT NULL, source TEXT NOT NULL,
      matched_words TEXT NOT NULL DEFAULT '[]', matched_initial INTEGER NOT NULL DEFAULT 0, alerted INTEGER NOT NULL DEFAULT 0,
      UNIQUE(video_id,fingerprint)
    );
    CREATE TABLE IF NOT EXISTS observations (
      id INTEGER PRIMARY KEY, video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      likes_display TEXT NOT NULL, likes_value INTEGER, comments_display TEXT NOT NULL,
      comments_value INTEGER, observed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id INTEGER PRIMARY KEY, video_id INTEGER REFERENCES videos(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL,
      delivered_at TEXT, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT NOT NULL DEFAULT '', next_attempt_at TEXT
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS threshold_state (
      video_id INTEGER NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      kind TEXT NOT NULL, threshold INTEGER NOT NULL,
      PRIMARY KEY(video_id,kind)
    );
    CREATE INDEX IF NOT EXISTS idx_comments_discovered ON comments(discovered_at);
    CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at);
  `);
  if (!db.prepare('PRAGMA table_info(alerts)').all().some(column=>column.name==='next_attempt_at'))
    db.exec('ALTER TABLE alerts ADD COLUMN next_attempt_at TEXT');
  if (!db.prepare('PRAGMA table_info(comments)').all().some(column=>column.name==='matched_initial')) {
    db.exec('ALTER TABLE comments ADD COLUMN matched_initial INTEGER NOT NULL DEFAULT 0');
    db.exec("UPDATE comments SET matched_initial=1 WHERE matched_words!='[]'");
  }
  const prep = sql => db.prepare(sql);
  const iso = () => new Date().toISOString();
  const decodeVideo = row => row ? { ...row, paused: Boolean(row.paused), backfillDone: Boolean(row.backfill_done) } : undefined;
  const decodeComment = row => row ? { ...row, matchedWords: JSON.parse(row.matched_words), matchedInitial:Boolean(row.matched_initial) } : undefined;

  return {
    close() { db.close(); },
    raw: db,
    getSettings() {
      const value = { ...DEFAULTS };
      for (const row of prep('SELECT key,value FROM settings').all()) value[row.key] = row.value;
      return value;
    },
    setSettings(input) {
      const statement = prep('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
      for (const [key, value] of Object.entries(input)) if (key in DEFAULTS) statement.run(key, String(value));
      return this.getSettings();
    },
    addVideo(url, interval, backfillLimit = 200) {
      intervalMs(interval);
      if (!Number.isInteger(backfillLimit) || backfillLimit < 0 || backfillLimit > 10000) throw new Error('历史补采上限须为 0–10000');
      const result = prep('INSERT INTO videos(url,interval,backfill_limit,backfill_done,next_check) VALUES(?,?,?,?,?)').run(url, interval, backfillLimit, backfillLimit === 0 ? 1 : 0, iso());
      return this.getVideo(Number(result.lastInsertRowid));
    },
    getVideo(id) { return decodeVideo(prep('SELECT * FROM videos WHERE id=?').get(id)); },
    getVideoByUrl(url) { return decodeVideo(prep('SELECT * FROM videos WHERE url=?').get(url)); },
    listVideos() { return prep('SELECT * FROM videos ORDER BY id DESC').all().map(decodeVideo); },
    updateVideo(id, patch) {
      const allowed = new Set(['title','paused','interval','backfill_limit','backfill_done','backfill_count','last_check','next_check','status','error','failures','likes_display','likes_value','comments_display','comments_value']);
      const entries = Object.entries(patch).filter(([key]) => allowed.has(key));
      if (entries.length) prep(`UPDATE videos SET ${entries.map(([key]) => `${key}=?`).join(',')} WHERE id=?`).run(...entries.map(([, value]) => value), id);
      return this.getVideo(id);
    },
    deleteVideos(ids) {
      const stmt = prep('DELETE FROM videos WHERE id=?');
      for (const id of ids) stmt.run(id);
    },
    addComment(comment) {
      const result = prep(`INSERT OR IGNORE INTO comments(video_id,fingerprint,platform_id,body,author,published_at,discovered_at,source,matched_words,matched_initial)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(comment.videoId, comment.fingerprint, comment.platformId ?? null, comment.body, comment.author ?? '', comment.publishedAt ?? '', comment.discoveredAt ?? iso(), comment.source, JSON.stringify(comment.matchedWords ?? []), (comment.matchedWords?.length || 0)>0 ? 1 : 0);
      const row = prep('SELECT * FROM comments WHERE video_id=? AND fingerprint=?').get(comment.videoId, comment.fingerprint);
      return { inserted: result.changes === 1, comment: decodeComment(row) };
    },
    listComments(videoId, options = {}) {
      const filters = []; const params = [];
      if (videoId != null) { filters.push('video_id=?'); params.push(videoId); }
      if (options.source) { filters.push('source=?'); params.push(options.source); }
      if (options.after) { filters.push('discovered_at>=?'); params.push(options.after); }
      const sql = `SELECT * FROM comments ${filters.length ? `WHERE ${filters.join(' AND ')}` : ''} ORDER BY discovered_at DESC,id DESC LIMIT ?`;
      return prep(sql).all(...params, Math.min(Number(options.limit) || 1000, 100000)).map(decodeComment);
    },
    countComments(videoId, source) {
      const clauses = []; const params = [];
      if (videoId != null) { clauses.push('video_id=?'); params.push(videoId); }
      if (source) { clauses.push('source=?'); params.push(source); }
      return Number(prep(`SELECT count(*) AS n FROM comments ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}`).get(...params).n);
    },
    updateCommentMatch(id, words, alerted = false) {
      prep('UPDATE comments SET matched_words=?, alerted=? WHERE id=?').run(JSON.stringify(words), alerted ? 1 : 0, id);
    },
    addObservation(videoId, data) {
      prep('INSERT INTO observations(video_id,likes_display,likes_value,comments_display,comments_value,observed_at) VALUES(?,?,?,?,?,?)')
        .run(videoId, data.likesDisplay, data.likesValue, data.commentsDisplay, data.commentsValue, data.observedAt ?? iso());
    },
    getCommentsByIds(ids) {
      const stmt = prep('SELECT * FROM comments WHERE id=?');
      return ids.map(id => decodeComment(stmt.get(id))).filter(Boolean);
    },
    listObservationsAll() { return prep('SELECT * FROM observations ORDER BY observed_at DESC,id DESC').all(); },
    getFirstObservation(videoId) {
      return prep('SELECT * FROM observations WHERE video_id=? ORDER BY id ASC LIMIT 1').get(videoId);
    },
    listObservations(videoId) {
      return prep('SELECT * FROM observations WHERE video_id=? ORDER BY observed_at DESC,id DESC').all(videoId);
    },
    queueAlert(videoId, kind, payload) {
      const result = prep('INSERT INTO alerts(video_id,kind,payload,created_at) VALUES(?,?,?,?)').run(videoId, kind, JSON.stringify(payload), iso());
      return this.getAlert(Number(result.lastInsertRowid));
    },
    getAlert(id) { const row = prep('SELECT * FROM alerts WHERE id=?').get(id); return row && { ...row, payload: JSON.parse(row.payload) }; },
    listAlerts(options = {}) {
      const filters=[];const params=[];
      if (options.pending || options.due) filters.push('delivered_at IS NULL');
      if (options.due) {filters.push('(next_attempt_at IS NULL OR next_attempt_at<=?)');params.push(options.now || iso());}
      if (options.beforeId) {filters.push('id<?');params.push(Number(options.beforeId));}
      if (options.videoId) {filters.push('video_id=?');params.push(Number(options.videoId));}
      if (options.kind) {filters.push('kind=?');params.push(options.kind);}
      if (options.from) {filters.push('created_at>=?');params.push(options.from);}
      if (options.to) {filters.push('created_at<?');params.push(options.to);}
      const where=filters.length?`WHERE ${filters.join(' AND ')}`:'';
      return prep(`SELECT * FROM alerts ${where} ORDER BY id DESC LIMIT ?`).all(...params,Math.min(Number(options.limit) || 1000,10000)).map(row => ({ ...row, payload: JSON.parse(row.payload) }));
    },
    markAlertSent(id, at = iso()) { prep('UPDATE alerts SET delivered_at=?, attempts=attempts+1,last_error=?,next_attempt_at=NULL WHERE id=?').run(at,'',id); },
    markAlertFailed(id, error, at = iso()) {
      const attempts=this.getAlert(id)?.attempts || 0;
      const wait=Math.min(3600000,60000*2**Math.min(attempts,6));
      prep('UPDATE alerts SET attempts=attempts+1,last_error=?,next_attempt_at=? WHERE id=?').run(String(error),new Date(new Date(at).getTime()+wait).toISOString(),id);
    },
    getThresholdState(videoId, kind) { return prep('SELECT threshold FROM threshold_state WHERE video_id=? AND kind=?').get(videoId,kind)?.threshold; },
    setThresholdState(videoId, kind, threshold) { prep('INSERT INTO threshold_state(video_id,kind,threshold) VALUES(?,?,?) ON CONFLICT(video_id,kind) DO UPDATE SET threshold=excluded.threshold').run(videoId,kind,threshold); }
  };
}
