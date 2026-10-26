const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const when = value => value ? new Date(value).toLocaleString('zh-CN',{hour12:false}) : '尚未检查';
const nameOf = video => video?.title || video?.url || '已删除视频';
const kindName = {historical_keyword:'历史评论命中汇总',new_keyword:'新评论命中',recovery_keyword:'恢复补采命中',rematch_keyword:'词库更新重匹配',likes_threshold:'点赞量阈值',comments_threshold:'评论总数阈值',test:'连接测试'};
const localDay = value => new Date(value).toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'});
const todayAlerts = () => state.alerts.filter(alert=>alert.kind!=='test'&&localDay(alert.created_at)===localDay(Date.now()));
let state;
let view='dashboard';
let pendingDelete=[];
let toastTimer;
let settingsLoaded=false;
let hitAlerts=[];
let hitNextBefore=null;
let reportRequestId=0;
const navIcons={
  dashboard:'<rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/>',
  videos:'<rect x="2.5" y="4" width="19" height="16" rx="3"/><path d="m10 8 6 4-6 4z"/>',
  rules:'<path d="M4 6h16M4 12h16M4 18h16"/><circle cx="9" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="10" cy="18" r="2"/>',
  hits:'<path d="M20 11.5a8 8 0 0 1-8 8 8.6 8.6 0 0 1-3-.6L4 20l1.1-4.2A8 8 0 1 1 20 11.5Z"/><path d="M9 11.5h6M12 8.5v6"/>',
  reports:'<path d="M3 20h18M6 17v-5M11 17V7M16 17v-8M21 17V4"/>',
  status:'<circle cx="12" cy="12" r="9"/><path d="M5 12h4l2-4 3 8 2-4h3"/>',
  settings:'<path d="M10 2.7h4l.5 2.1 1.7.7 1.8-1.1 2.8 2.8-1.1 1.8.7 1.7 2.1.5v4l-2.1.5-.7 1.7 1.1 1.8-2.8 2.8-1.8-1.1-1.7.7-.5 2.1h-4l-.5-2.1-1.7-.7-1.8 1.1-2.8-2.8 1.1-1.8-.7-1.7-2.1-.5v-4l2.1-.5.7-1.7-1.1-1.8 2.8-2.8 1.8 1.1 1.7-.7z"/><circle cx="12" cy="12" r="3"/>'
};
document.querySelectorAll('.side [data-view]').forEach(button=>{
  const label=button.dataset.view==='settings'?'设置':button.textContent.trim();
  const icon=document.createElement('span');icon.className='nav-icon';icon.setAttribute('aria-hidden','true');
  icon.innerHTML=`<svg viewBox="0 0 24 24">${navIcons[button.dataset.view]}</svg>`;
  button.replaceChildren(icon,document.createTextNode(label));
});

function toast(message,duration=4500) {
  $('toast-text').textContent=message;
  $('toast').classList.add('show');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>$('toast').classList.remove('show'),duration);
}
function deltaLabel(value,approximate) {
  if (value == null) return '较首次暂无数据';
  return `较首次${approximate?'约':''} ${value>=0?'+':''}${value.toLocaleString('zh-CN')}`;
}

async function api(path,method='GET',body) {
  const response=await fetch(path,{method,headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function showView(next) {
  view=next;
  document.querySelectorAll('.side [data-view]').forEach(item=>item.classList.toggle('active',item.dataset.view===next));
  document.querySelectorAll('.preview-view').forEach(item=>item.hidden=item.id!==`view-${next}`);
  if (next==='reports') void renderReport();
  if (next==='settings') void loginStatus();
  if (next==='hits') void loadHits(true);
}

function chart(target,labels,buckets,metric='newComments') {
  if (buckets.every(bucket=>!bucket[metric])) {
    $(target).innerHTML='<div class="chart-empty"><b>本期暂无新增评论</b><span>后续采集到新评论后显示趋势</span></div>';
    $(labels).innerHTML='';
    $(target).classList.add('is-empty');
    return;
  }
  $(target).classList.remove('is-empty');
  const peak=Math.max(1,...buckets.map(bucket=>bucket[metric]||0));
  $(target).innerHTML=buckets.map(bucket=>`<div class="bar-cell"><b>${esc(bucket[metric]||0)}</b><i style="height:${Math.max(3,Math.round((bucket[metric]||0)/peak*75))}px"></i></div>`).join('');
  $(labels).innerHTML=buckets.map(bucket=>`<span title="${esc(bucket.key)}">${esc(bucket.key.slice(5))}</span>`).join('');
}

function renderDashboard() {
  const videos=state.videos;
  const round=state.lastRound;
  const alertsToday=todayAlerts();
  $('dashboard-running').textContent=`${videos.filter(video=>!video.paused).length} 条视频监测中`;
  $('dash-new-comments').textContent=round.count;
  $('dash-new-source').textContent=`来自 ${round.sources.length} 条视频 · 点击查看`;
  $('dash-alerts').textContent=alertsToday.length;
  const likes=state.today.totals.likesValue;
  const oneRaw=videos.length===1&&videos[0].likes_display;
  const compact=likes>=100000000?`${(likes/100000000).toFixed(1)}亿`:likes>=10000?`${(likes/10000).toFixed(1)}万`:likes.toLocaleString('zh-CN');
  $('dash-likes').textContent=oneRaw||`${state.today.totals.likesApproximate?'约':''}${compact}`;
  $('dash-keywords').textContent=state.settings.keywords || '尚未设置';
  const thresholds=[state.settings.likesThreshold?`点赞达到 ${state.settings.likesThreshold}`:null,state.settings.commentsThreshold?`评论达到 ${state.settings.commentsThreshold}`:null].filter(Boolean);
  $('dash-thresholds').textContent=thresholds.join('；')||'尚未设置';
  $('dashboard-videos').innerHTML=videos.slice(0,5).map(video=>`<tr><td><a href="${esc(video.url)}" target="_blank" rel="noopener noreferrer">${esc(nameOf(video))}</a><br><span class="muted">已采 ${video.storedComments} 条</span></td><td>${esc(video.likes_display||'—')} / ${esc(video.comments_display||'—')}</td><td>${esc(when(video.next_check))}</td><td><span class="${video.status==='正常'?'pill':'tag'}">${esc(video.status)}</span></td></tr>`).join('')||'<tr><td colspan="4" class="empty">尚未添加视频。</td></tr>';
  chart('dash-chart','dash-chart-labels',state.today.buckets);
  const latest=state.alerts[0];
  $('latest-alert').innerHTML=latest?`<b>${esc(kindName[latest.kind]||latest.kind)}</b><br>作品：${esc(latest.payload.title||'—')}<br>原因：${esc(latest.payload.reason||'—')}<br><span class="muted">${esc(when(latest.created_at))} · ${latest.delivered_at?'已发送':'待发送'} · <button class="link-button" data-go="hits">查看记录</button></span>`:'尚无提醒。';
}

function selectedIds() { return [...document.querySelectorAll('.video-check-v6:checked')].map(box=>Number(box.value)); }
function updateSelection() {
  const boxes=document.querySelectorAll('.video-check-v6');
  $('selected-count').textContent=`已选 ${selectedIds().length} 条`;
  $('select-all').checked=boxes.length>0&&selectedIds().length===boxes.length;
  $('select-all').indeterminate=selectedIds().length>0&&selectedIds().length<boxes.length;
}

function renderVideos() {
  $('video-running').textContent=`${state.videos.filter(video=>!video.paused).length} 条运行中`;
  const checked=new Set(selectedIds());
  $('video-rows').innerHTML=state.videos.map(video=>`<tr data-id="${video.id}"><td><input class="video-check-v6" type="checkbox" value="${video.id}" aria-label="选择 ${esc(nameOf(video))}" ${checked.has(video.id)?'checked':''}></td><td class="video-title"><a href="${esc(video.url)}" target="_blank" rel="noopener noreferrer">${esc(nameOf(video))}</a><br><span class="muted">历史补采 ${video.backfill_count}/${video.backfill_limit} · ${video.backfillDone?'已停止历史补采':'进行中'} · 已采 ${video.storedComments} 条</span><br><span class="muted">间隔 ${esc(video.interval)}</span></td><td>${esc(video.likes_display||'—')}<br><span class="muted">${esc(video.changeSinceFirst?deltaLabel(video.changeSinceFirst.likes,video.changeSinceFirst.likesApproximate):'待首次采集')}</span></td><td>${esc(video.comments_display||'—')}<br><span class="muted">${esc(video.changeSinceFirst?deltaLabel(video.changeSinceFirst.comments,video.changeSinceFirst.commentsApproximate):'待首次采集')}</span></td><td>${esc(when(video.last_check))}<br><span class="muted">${video.paused?'已暂停':esc(when(video.next_check))}</span></td><td><span class="${video.status==='正常'?'pill':'tag'}">${esc(video.status)}</span>${video.error?`<br><span class="muted" title="${esc(video.error)}">${esc(video.error.slice(0,80))}</span>`:''}</td><td><button class="stop-collection-v12" data-action="${video.paused?'resume':'pause'}" data-id="${video.id}">${video.paused?'恢复采集':'停止采集'}</button><button class="stop-collection-v12" data-action="check" data-id="${video.id}">立即检查</button><button class="row-delete" data-action="delete" data-id="${video.id}">删除</button></td></tr>`).join('')||'<tr><td colspan="7" class="empty">尚未添加视频。上方粘贴链接后添加。</td></tr>';
  updateSelection();
}

function renderRules() {
  $('rules-keywords').textContent=state.settings.keywords||'尚未设置';
  $('rules-likes').textContent=state.settings.likesThreshold?`点赞量达到 ${state.settings.likesThreshold}`:'点赞量：未设置';
  $('rules-comments').textContent=state.settings.commentsThreshold?`评论总数达到 ${state.settings.commentsThreshold}`:'评论总数：未设置';
}

function renderHits() {
  const selected=$('hit-video-filter').value;
  $('hit-video-filter').innerHTML='<option value="">全部</option>'+state.videos.map(video=>`<option value="${video.id}">${esc(nameOf(video))}</option>`).join('');
  $('hit-video-filter').value=selected;
  $('hit-rows').innerHTML=hitAlerts.map(alert=>{
    const video=state.videos.find(v=>v.id===alert.video_id);
    return `<tr><td>${esc(when(alert.created_at))}</td><td><span class="hit-title" title="${esc(alert.payload.title||nameOf(video))}">${esc(alert.payload.title||nameOf(video))}</span></td><td>${esc(kindName[alert.kind]||alert.kind)}</td><td>${esc(alert.payload.count?`${alert.payload.count} 条评论`:alert.payload.reason||'—')}</td><td><span class="${alert.delivered_at?'pill':'tag'}">${alert.delivered_at?'已推送':alert.last_error?'发送失败，待重试':'待发送'}</span></td><td><button class="hit-open-v13" data-alert="${alert.id}">${alert.payload.commentIds?.length?'查看命中评论':'查看详情'}</button></td></tr>`;
  }).join('')||'<tr><td colspan="6" class="empty">暂无记录。</td></tr>';
  $('hit-more').hidden=!hitNextBefore;
}

async function loadHits(reset=false) {
  if (reset) {hitAlerts=[];hitNextBefore=null;}
  const params=new URLSearchParams({limit:'100'});
  if ($('hit-video-filter').value) params.set('videoId',$('hit-video-filter').value);
  if ($('hit-type-filter').value) params.set('kind',$('hit-type-filter').value);
  if ($('hit-date-filter').value) params.set('date',$('hit-date-filter').value);
  if (!reset && hitNextBefore) params.set('before',hitNextBefore);
  try {
    const data=await api(`/api/alerts?${params}`);
    hitAlerts.push(...data.alerts);
    hitNextBefore=data.nextBefore;
    renderHits();
  } catch(error) {toast(error.message);}
}

function renderStatus() {
  const videos=state.videos;
  $('status-running').textContent=videos.filter(video=>!video.paused).length;
  $('status-issues').textContent=videos.filter(video=>['登录失效','待重试','部分评论未读取'].includes(video.status)).length;
  $('status-feishu').textContent=state.settings.feishuConfigured?'已配置':'未配置';
  $('status-list').innerHTML=videos.map(video=>`<div class="rule"><b>${esc(nameOf(video))}</b>${esc(video.status)} · 上次：${esc(when(video.last_check))} · 下次：${video.paused?'已暂停':esc(when(video.next_check))}${video.error?`<br><span class="status-error">${esc(video.error)}</span>`:''}</div>`).join('')||'<p class="empty">尚无监测任务。</p>';
  $('top-status').textContent=`本机运行中 · ${state.settings.feishuConfigured?'飞书已配置':'飞书未配置'}`;
}

function renderSettings() {
  if (settingsLoaded) return;
  const s=state.settings;
  $('setting-interval').value=s.interval;
  $('setting-backfill').value=s.backfillLimit;
  $('setting-keywords').value=s.keywords;
  $('setting-likes').value=s.likesThreshold;
  $('setting-comments').value=s.commentsThreshold;
  $('setting-concurrency').value=s.concurrency;
  $('bulk-interval').value=s.interval;
  $('webhook-state').textContent=s.feishuConfigured?`已保存 Webhook${s.feishuSigningConfigured?'及签名密钥':''}；完整内容隐藏。留空表示保持原值。`:'尚未配置。';
  settingsLoaded=true;
}

function renderReportOptions() {
  const selected=new Set([...document.querySelectorAll('#report-videos-menu input:checked')].map(input=>input.value));
  $('report-videos-menu').innerHTML=state.videos.map(video=>`<label class="report-video-option"><input class="report-video-check" type="checkbox" value="${video.id}" ${selected.has(String(video.id))?'checked':''}><span title="${esc(nameOf(video))}">${esc(nameOf(video))}</span></label>`).join('')||'<span class="muted">暂无监测视频</span>';
  updateReportPicker();
}

function updateReportPicker() {
  const count=document.querySelectorAll('#report-videos-menu input:checked').length;
  $('report-videos-toggle').textContent=count?`已选 ${count} 条视频 ▾`:'全部视频 ▾';
}

async function renderReport() {
  if (!state) return;
  const requestId=++reportRequestId;
  try {
    const ids=[...document.querySelectorAll('#report-videos-menu input:checked')].map(input=>input.value);
    const params=new URLSearchParams({period:$('report-period').value});
    if (ids.length) params.set('ids',ids.join(','));
    const data=await api(`/api/report?${params}`);
    if (requestId!==reportRequestId) return;
    $('report-new').textContent=data.totals.newComments;
    $('report-hits').textContent=data.totals.hits;
    $('report-likes-change').textContent=data.totals.likesChange.toLocaleString('zh-CN');
    $('report-history').textContent=`本期补采 ${data.totals.historicalCollected} 条；累计已存 ${data.totals.storedComments} 条。`;
    $('report-totals').innerHTML=`<div class="rule">监测视频：${data.totals.videos} 条</div><div class="rule">累计点赞：${data.totals.likesApproximate?'约':''}${data.totals.likesValue.toLocaleString('zh-CN')}</div><div class="rule">页面评论总数合计：${data.totals.displayedCommentTotal.toLocaleString('zh-CN')}</div><div class="rule">本期评论总数变化：${data.totals.commentTotalChange.toLocaleString('zh-CN')}</div><div class="rule">词库更新重匹配：${data.totals.rematches} 条</div>`;
    chart('report-chart','report-labels',data.buckets);
  } catch(error) {if (requestId===reportRequestId) toast(error.message);}
}

async function refresh() {
  try {
    state=await api('/api/state');
    renderDashboard();renderVideos();renderRules();renderHits();renderStatus();renderSettings();renderReportOptions();
    if (view==='reports') await renderReport();
  } catch(error) { toast(`读取状态失败：${error.message}`); }
}

function showCard(kind) {
  let title='',body='';
  if (kind==='comments') {
    title=`本轮新评论 · ${state.lastRound.count} 条`;
    body=`<p class="muted">按各视频最近一次成功检查归集；可展开查看本轮评论。</p><table class="table"><thead><tr><th>视频</th><th>本轮新评论</th></tr></thead><tbody>${state.lastRound.sources.map(source=>`<tr><td><details><summary>${esc(source.title)}</summary>${source.comments.map(comment=>`<p><span class="muted">${esc(comment.author)} · ${esc(when(comment.discovered_at))}</span><br>${esc(comment.body)}</p>`).join('')}</details></td><td>${source.comments.length} 条</td></tr>`).join('')||'<tr><td colspan="2">暂无本轮新评论。</td></tr>'}</tbody></table>`;
  } else if (kind==='alerts') {
    title=`今日命中提醒 · ${$('dash-alerts').textContent} 条`;
    body=`<table class="table"><thead><tr><th>时间</th><th>视频</th><th>提醒原因</th><th>状态</th></tr></thead><tbody>${todayAlerts().map(alert=>`<tr><td>${esc(when(alert.created_at))}</td><td>${esc(alert.payload.title)}</td><td>${esc(alert.payload.reason||kindName[alert.kind])}</td><td>${alert.delivered_at?'已发送':'待发送'}</td></tr>`).join('')||'<tr><td colspan="4">暂无提醒。</td></tr>'}</tbody></table><button class="settings-action" data-go="hits">打开命中记录</button>`;
  } else {
    title=`监测视频累计点赞 · ${$('dash-likes').textContent}`;
    body=`<p class="muted">各视频保留抖音页面显示值。含「万」「亿」的合计为约数。</p><table class="table"><thead><tr><th>视频</th><th>页面显示点赞量</th></tr></thead><tbody>${state.videos.map(video=>`<tr><td><a href="${esc(video.url)}" target="_blank" rel="noopener noreferrer">${esc(nameOf(video))}</a></td><td>${esc(video.likes_display||'尚未检查')}</td></tr>`).join('')||'<tr><td colspan="2">尚未添加视频。</td></tr>'}</tbody></table>`;
  }
  $('modal-title').textContent=title;
  $('modal-body').innerHTML=body;
  $('card-modal').hidden=false;
  $('card-modal').classList.add('open');
  $('card-modal').focus();
}

function closeCard() {$('card-modal').classList.remove('open');$('card-modal').hidden=true;}
async function loginStatus() { try {const data=await api('/api/login/status');$('login-badge').textContent=data.sessionSaved?'已保存登录会话':'未登录或会话未识别';}catch(error){$('login-badge').textContent=`检查失败：${error.message}`;} }

async function addVideos() {
  try {
    const data=await api('/api/videos','POST',{links:$('video-links').value});
    $('add-result').textContent=`已添加 ${data.added.length} 条；重复 ${data.duplicates.length} 条；失败 ${data.errors.length} 条。${data.errors.map(item=>item.message).join('；')}`;
    if (data.added.length) $('video-links').value='';
    await refresh();
  } catch(error) { toast(error.message); }
}

async function saveSettings(field=null) {
  try {
    const fields={interval:'setting-interval',backfillLimit:'setting-backfill',keywords:'setting-keywords',
      likesThreshold:'setting-likes',commentsThreshold:'setting-comments',concurrency:'setting-concurrency',
      feishuWebhook:'setting-webhook',feishuSecret:'setting-secret'};
    const body={};
    for (const [key,id] of Object.entries(fields)) {
      if (field && field!==key) continue;
      const value=$(id).value;
      if ((key==='feishuWebhook'||key==='feishuSecret')&&!value.trim()) continue;
      body[key]=value;
    }
    if (!Object.keys(body).length) throw new Error('请先填写配置内容');
    if ('interval' in body) body.applyIntervalToAll=$('apply-interval-all').checked;
    const data=await api('/api/settings','PUT',body);
    if ('feishuWebhook' in body) $('setting-webhook').value='';
    if ('feishuSecret' in body) $('setting-secret').value='';
    if (!field) settingsLoaded=false;
    await refresh();
    toast(`配置已保存${data.rematch?`；已存评论新增命中 ${data.rematch.matched} 条`:''}`,1500);
  } catch(error) { toast(error.message); }
}

async function openHit(id,button) {
  const existing=button.closest('tr').nextElementSibling;
  if (existing?.classList.contains('hit-detail-v13')) {existing.remove();button.textContent='查看详情';return;}
  try {
    const data=await api(`/api/alerts/${id}`);
    const row=document.createElement('tr');row.className='hit-detail-v13';
    const list=data.comments.map(comment=>`<div class="hit-comment-v13"><span class="muted">${esc(comment.author)} · ${esc(when(comment.discovered_at))} · 命中「${esc(comment.matchedWords.join('、'))}」</span><br>${esc(comment.body)}</div>`).join('');
    row.innerHTML=`<td colspan="6"><b>${esc(data.alert.payload.title||'命中详情')} · ${esc(data.alert.payload.reason||kindName[data.alert.kind])}</b><div class="hit-list-v13">${list||`<div class="hit-comment-v13">${esc(data.alert.payload.reason||'无关联评论')}</div>`}</div></td>`;
    button.closest('tr').after(row);button.textContent='收起详情';
  } catch(error) {toast(error.message);}
}

document.addEventListener('click',async event=>{
  if(event.target.id==='report-videos-toggle') {const menu=$('report-videos-menu');menu.hidden=!menu.hidden;event.target.setAttribute('aria-expanded',String(!menu.hidden));return;}
  if(!event.target.closest('.report-video-picker')) {$('report-videos-menu').hidden=true;$('report-videos-toggle').setAttribute('aria-expanded','false');}
  const nav=event.target.closest('[data-view]');if(nav){showView(nav.dataset.view);return;}
  const go=event.target.closest('[data-go]');if(go){closeCard();showView(go.dataset.go);return;}
  const card=event.target.closest('[data-card]');if(card){showCard(card.dataset.card);return;}
  if(event.target.id==='modal-close'||event.target.id==='card-modal'){closeCard();return;}
  const alertButton=event.target.closest('[data-alert]');if(alertButton){await openHit(alertButton.dataset.alert,alertButton);return;}
  const videoButton=event.target.closest('[data-action][data-id]');
  if(videoButton){const id=Number(videoButton.dataset.id),action=videoButton.dataset.action;
    if(action==='delete'){pendingDelete=[id];$('delete-count').textContent='1';$('delete-confirm').style.display='block';return;}
    try {await api(`/api/videos/${id}/${action}`,'POST',{});toast(action==='pause'?'已停止采集':action==='resume'?'已恢复采集':'已开始检查');await refresh();}catch(error){toast(error.message);}return;
  }
  if(event.target.id==='add-video') return void addVideos();
  if(event.target.id==='toast-close') {clearTimeout(toastTimer);$('toast').classList.remove('show');return;}
  const apply=event.target.closest('[data-apply-setting]');if(apply) return void saveSettings(apply.dataset.applySetting);
  if(event.target.id==='save-settings'||event.target.id==='save-settings-top') return void saveSettings();
  if(event.target.id==='selected-delete') {pendingDelete=selectedIds();if(!pendingDelete.length){toast('请先勾选视频');return;}$('delete-count').textContent=pendingDelete.length;$('delete-confirm').style.display='block';return;}
  if(event.target.id==='cancel-delete') {$('delete-confirm').style.display='none';pendingDelete=[];return;}
  if(event.target.id==='confirm-delete') {try {await api('/api/videos','DELETE',{ids:pendingDelete});$('delete-confirm').style.display='none';pendingDelete=[];toast('已删除视频及本地记录');await refresh();}catch(error){toast(error.message);}return;}
  if(event.target.id==='apply-bulk-interval') {try {const ids=selectedIds();if(!ids.length)throw new Error('请先勾选视频');await api('/api/videos/interval','PUT',{ids,interval:$('bulk-interval').value});toast('检查间隔已更新');await refresh();}catch(error){toast(error.message);}return;}
  if(event.target.id==='check-all') {try {await api('/api/check-all','POST',{});toast('已开始检查到期的视频');}catch(error){toast(error.message);}return;}
  if(event.target.id==='open-login') {try {await api('/api/login/open','POST',{});toast('已打开抖音官方页面，请在弹出的浏览器中登录');}catch(error){toast(error.message);}return;}
  if(event.target.id==='verify-login') {try {const data=await api('/api/login/verify','POST',{});$('login-badge').textContent=data.sessionSaved?'已保存登录会话':'仍未识别登录会话';toast(data.sessionSaved?'已恢复待检查任务':'请先完成抖音登录');await refresh();}catch(error){toast(error.message);}return;}
  if(event.target.id==='test-feishu') {try {await api('/api/feishu/test','POST',{});toast('测试提醒已发送，请检查手机飞书');await refresh();}catch(error){toast(error.message);}return;}
  if(event.target.id==='hit-more') return void loadHits(false);
  if(event.target.closest('td:first-child')?.querySelector('.video-check-v6')&&event.target.tagName!=='INPUT') event.target.closest('td').querySelector('input').click();
});
document.addEventListener('change',event=>{if(event.target.id==='select-all'){document.querySelectorAll('.video-check-v6').forEach(box=>box.checked=event.target.checked);updateSelection();}if(event.target.classList.contains('video-check-v6'))updateSelection();if(event.target.classList.contains('report-video-check')){updateReportPicker();void renderReport();}if(event.target.id==='report-period')void renderReport();if(['hit-video-filter','hit-type-filter','hit-date-filter'].includes(event.target.id))void loadHits(true);});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeCard();});
void refresh();
setInterval(()=>{if(!document.hidden)void refresh();},20000);
