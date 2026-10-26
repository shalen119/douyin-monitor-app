# 抖音监测桌宠 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把已确认的蓝色像素桌宠制成 Windows 可双击启动的常驻入口，绑定现有抖音监测服务并显示真实采集状态与提醒。

**Architecture:** 保留现有 Node.js 服务与网页。服务增加只面向本机的桌宠运行状态接口；桌宠用 Windows Forms 无边框置顶透明窗口、系统托盘和外部 Node 进程管理。逐帧图以 PNG 图集保存，窗口按帧绘制；角色行为与服务状态、提醒事件分离。

**Tech Stack:** Node.js 24、内置 `node:sqlite`、C# 5 / .NET Framework 4.8 Windows Forms、System.Drawing PNG 图集、Windows PowerShell 安装脚本。

**Spec:** `../specs/2026-10-25-desktop-pet-design.md`

## Global Constraints

- 手动双击启动；不开机自启；后台不留 CMD；现有网页、飞书、抖音 Edge 登录和数据口径保持可用。
- 桌宠始终置顶、可拖动、可隐藏到托盘；只有“退出监测”停止由桌宠启动的服务。
- 每次启动播放一次睡醒开场；命中词与点赞/评论总数阈值触发小跳；历史补采与手动重匹配仅轻提示。
- 采集数是此刻同时正在检查的视频数，不是监测视频总数；无语音，不展示完整评论或密钥。
- 偶发提醒默认本地 10:00–21:00、每日 1–2 次、至少相隔 3 小时，可禁用；不执行账号操作。
- 开发在独立 `work/pet-build` 副本进行，避免干扰运行中的监测数据；最终复制经过验证的源码与素材到交付目录。当前目录不是 Git 仓库，因此不执行 Git 提交。

## Review Focus

- 端口被其他服务占用时，桌宠报错而不是连接或杀死该进程；在 Task 3 的启动烟测覆盖。
- 桌宠重连时不会把旧提醒当新提醒再跳一次；在 Task 1、3 的事件测试覆盖。
- 多条同时检查、失败和完成交错时，运行数始终等于正在检查的任务数；在 Task 1 的测试覆盖。
- 隐藏到托盘后仍能退出，退出时只终止自己启动的服务；在 Task 3 的进程烟测覆盖。
- 设置为跨午夜、无效时间或每日零次时，提醒日程仍有确定行为；在 Task 3 的设置测试覆盖。

---

### Task 1: 服务端桌宠状态和全局暂停

**Files:** Modify `src/monitor.js`, `src/store.js`, `src/server.js`; test `test/monitor.test.js`, `test/api.test.js`.

**Interfaces:** `monitor.runtime()` returns `{activeCount, activeVideos:[{id,title,url}], globallyPaused}`; `monitor.setGlobalPause(paused:boolean)` saves independent setting `globalPaused` without mutating each video's `paused`; `GET /api/pet/state?afterAlertId=N` returns `{serviceId, runtime, events, newestAlertId}` with only alerts newer than N. `serviceId` identifies this app instance and is included in `/api/state`. `POST /api/pet/pause` and `/api/pet/resume` set global pause. Alert events expose ID, kind, video ID, title, and destination, but no secret or full comment.

- [ ] Write failing monitor and API tests for concurrent active count, pause persistence, alert filtering/classification, and endpoint identity; run `node --test test/monitor.test.js test/api.test.js` and see failures.
- [ ] Implement the monitor runtime, store persistence and API. Existing per-video controls keep their behavior; `tick` skips when globally paused. Explicit manual checks also honor global pause.
- [ ] Run targeted tests and then `npm test`; all pass.

### Task 2: 角色逐帧素材与预览

**Files:** Create `pet/assets/*.png`, `pet/assets/manifest.json`, `pet/preview.html`; reference `docs/superpowers/specs/assets/blue-pet-turnaround.png`.

**Interfaces:** Manifest maps `wake`, `idle`, `work`, `hit`, `error` and idle variations to PNG source rectangles and frame durations. All sequences share a fixed canvas anchor at the feet. Images have actual alpha transparency and preserve the approved character's hair, star clip and outfit.

- [ ] Generate initial pixel-art pose strips for wake, idle variations, work, hit jump and error with the approved image as reference.
- [ ] Inspect the strips at native and 140 px desktop size; revise any inconsistent face, outfit, background transparency or clipped frame.
- [ ] Author the frame manifest and simple preview; check each loop, wake once and hit once visually. The preview is a review artifact, not a replacement for the Windows pet.

### Task 3: Windows desktop pet and process ownership

**Files:** Create `pet/DesktopPet.cs`, `pet/PetLogic.cs`, `pet/build.ps1`, `pet/README.md`; test `test/pet.test.js` and `pet/PetLogicTests.cs`.

**Interfaces:** `DesktopPet.exe` runs from the app root and uses its sibling `src/server.js`, `node_modules`, `data`, and `pet/assets`. `PetLogic` supplies deterministic phrase selection, Chinese count wording, state priority, reminder scheduling and seen-alert cursor. The app starts/attaches to `127.0.0.1:4318`, owns only the process it creates, and polls `/api/pet/state` with a bounded interval.

- [ ] Write failing tests for phrase/count rendering, reminder windows including midnight, seen-alert dedup, API unavailability, and process ownership; verify failures.
- [ ] Build the transparent topmost WinForms window, per-frame renderer, click/drag, text bubble, tray menu and settings dialog. Keep graphics hit testing within visible pixels and support Windows DPI scaling.
- [ ] Implement startup wake animation, server start/attach/health check, paused/running/error state, deep links to monitor and alert details, and safe exit. Use `csc.exe` with `/target:winexe`; no console window remains open.
- [ ] Run pure logic tests and smoke test a visible pet against an isolated app copy. Verify browser close, tray hide/restore, service ownership and no duplicate service.

### Task 4: 安装、交付与回归

**Files:** Modify `install-environment.ps1`, `安装说明-先看我.txt`, `README.md`; create `双击启动桌宠.cmd` only if an EXE launcher cannot reliably locate the app root without it; package a ZIP with `DesktopPet.exe`, assets, server files and no user data.

**Interfaces:** Primary user entry is a double-clickable `DesktopPet.exe` with a Chinese shortcut name if useful. Installer checks the Windows .NET Framework 4.8 runtime and prepares Node/Edge/project dependencies; it must explain any unavailable prerequisite. Existing `启动抖音监测.cmd` remains a recovery path.

- [ ] Run installer from a fresh extracted package and verify dependencies, executable, sprite assets and no console persistence on desktop-pet launch.
- [ ] Run `npm test`, native logic tests and UI smoke checks; inspect tray, all five animations, alert destinations, reminder settings and `data` preservation.
- [ ] Build ZIP from an explicit allowlist, excluding `data`, `.runtime`, `node_modules` only if installer restores them, browser profiles and secrets. Re-extract and validate the packaged executable and file manifest.
