import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { createBrowser } from '../src/browser.js';
import { collectPage } from '../src/douyin.js';

async function fakeDouyinServer() {
  const server = http.createServer((request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    if (request.url === '/aweme/detail/') return response.end(JSON.stringify({ status_code: 0, aweme_detail: { desc: '测试视频', statistics: { digg_count: 5, comment_count: 1 } } }));
    if (request.url === '/comment/list/') return response.end(JSON.stringify({ status_code: 0, total: 1, has_more: 0, comments: [{ cid: '1', text: '测试评论' }] }));
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end('<body>测试视频\n5\n1\n全部评论<script>fetch("/aweme/detail/");fetch("/comment/list/")</script></body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}/video` };
}

test('collection Edge keeps its Chromium sandbox enabled', { skip: process.platform !== 'win32' }, async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'douyin-sandbox-test-'));
  const browser = createBrowser(profile, { headless: true });
  try {
    await browser.status();
    const quoted = profile.replaceAll("'", "''");
    const script = `$p=Get-CimInstance Win32_Process -Filter "name = 'msedge.exe'" | Where-Object { $_.CommandLine -like '*${quoted}*' }; if(-not $p){exit 2}; if($p | Where-Object { $_.CommandLine -like '*--no-sandbox*' }){exit 1}`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    assert.equal(result.status, 0, `Edge 启动参数含 --no-sandbox 或未找到进程：${result.stderr}`);
  } finally {
    await browser.close();
    assert.ok(path.resolve(profile).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(profile, { recursive: true, force: true });
  }
});

test('closing the last collection tab keeps the visible Edge context alive', { skip: process.platform !== 'win32' }, async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'douyin-last-page-test-'));
  const { server, url } = await fakeDouyinServer();
  const context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: false, chromiumSandbox: true });
  try {
    const first = context.pages()[0];
    const firstClosed = new Promise(resolve => context.once('page', page => { if (page !== first) void first.close().then(resolve); }));
    await collectPage(context, url, { commentLimit: 1 });
    await firstClosed;
    assert.ok(context.pages().some(page => page.url().endsWith('/video')), '采集后视频窗口应继续显示');
    const next = await context.newPage();
    await next.close();
  } finally {
    await context.close().catch(() => {});
    await new Promise(resolve => server.close(resolve));
    assert.ok(path.resolve(profile).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(profile, { recursive: true, force: true });
  }
});

test('collection browser relaunches after its window was closed', { skip: process.platform !== 'win32' }, async () => {
  const profile = await mkdtemp(path.join(tmpdir(), 'douyin-relaunch-test-'));
  const { server, url } = await fakeDouyinServer();
  const browser = createBrowser(profile, { headless: false });
  try {
    await browser.status();
    const quoted = profile.replaceAll("'", "''");
    const script = `$p=Get-CimInstance Win32_Process -Filter "name = 'msedge.exe'" | Where-Object { $_.CommandLine -like '*${quoted}*' -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1; if(-not $p){exit 2}; Stop-Process -Id $p.ProcessId -Force`;
    const killed = spawnSync('powershell.exe', ['-NoProfile', '-Command', script], { encoding: 'utf8' });
    assert.equal(killed.status, 0, killed.stderr);
    await new Promise(resolve => setTimeout(resolve, 500));
    const result = await browser.collect({ url }, { commentLimit: 1 });
    assert.equal(result.comments.length, 1);
  } finally {
    await browser.close().catch(() => {});
    await new Promise(resolve => server.close(resolve));
    assert.ok(path.resolve(profile).startsWith(path.resolve(tmpdir()) + path.sep));
    await rm(profile, { recursive: true, force: true });
  }
});
