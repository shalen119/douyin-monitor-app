import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../src/report.js';

test('period report excludes initial history from new comments but includes it in collected total', () => {
  const now = new Date('2026-10-24T06:00:00.000Z');
  const videos = [{id:1,likes_value:32000,likes_display:'3.2万',comments_value:343}];
  const comments = [
    {video_id:1,source:'historical',discovered_at:'2026-10-24T02:00:00.000Z',matchedWords:['投诉']},
    {video_id:1,source:'new',discovered_at:'2026-10-24T03:00:00.000Z',matchedWords:[]},
    {video_id:1,source:'recovery',discovered_at:'2026-10-24T04:00:00.000Z',matchedWords:['投诉']}
  ];
  const report=buildReport({videos,comments,observations:[],period:'day',now});
  assert.equal(report.totals.newComments,2);
  assert.equal(report.totals.historicalCollected,1);
  assert.equal(report.totals.storedComments,3);
  assert.equal(report.totals.likesValue,32000);
  assert.equal(report.buckets.at(-1).newComments,2);
});

test('keyword rematch is recorded on update day without backdating original hit', () => {
  const report=buildReport({videos:[{id:1,likes_value:0,likes_display:'0'}],comments:[
    {video_id:1,source:'historical',discovered_at:'2026-10-23T02:00:00.000Z',matchedWords:['新词'],matchedInitial:false}
  ],observations:[],alerts:[{video_id:1,kind:'rematch_keyword',created_at:'2026-10-24T02:00:00.000Z',payload:{count:1}}],period:'day',now:new Date('2026-10-24T06:00:00.000Z')});
  assert.equal(report.buckets.at(-2).hits,0);
  assert.equal(report.buckets.at(-1).rematches,1);
});
