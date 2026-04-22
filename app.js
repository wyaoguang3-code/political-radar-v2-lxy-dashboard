let hourChart, platformChart, mentionChart, redTrendChart, topicOwnChart;
let mode = '24h';

// In-memory cache of the latest fetched comment lists + history, so the modal
// and the red-list panel don't need to re-fetch on every interaction.
const state = {
  socialSignals: null,
  comments: { facebook: [], instagram: [], threads: [] },
  history: { facebook: [], instagram: [], threads: [] },
  topicHeat: null,
  selectedTopicId: null,
};

const LIGHT_ICON = { '紅':'🔴', '黃':'🟡', '綠':'🟢' };
const PLATFORM_LABEL = { facebook: 'Facebook', instagram: 'Instagram', threads: 'Threads' };
const RED_RATIO_ALERT = 0.25;     // 25%: show red banner
const YELLOW_RATIO_WARN = 0.40;   // 40% non-green: yellow banner

function lightLevelByCount(c, avg){
  if(c >= Math.max(10, avg*1.8)) return '紅';
  if(c >= Math.max(5, avg*1.2)) return '黃';
  return '綠';
}

function upsertChart(instance, ctx, config){
  if(instance){ instance.data=config.data; instance.options=config.options; instance.update(); return instance; }
  return new Chart(ctx, config);
}

function pick(d, key24, key7){ return mode==='7d' ? (d[key7] ?? d[key24]) : d[key24]; }

function escapeHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, c => (
    { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]
  ));
}

// --------- Data fetching ---------
async function fetchJSON(path){
  try {
    const r = await fetch(path + '?t=' + Date.now());
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// --------- Social signal cards (clickable) ---------
function renderSocialCards(){
  const wrap = document.getElementById('socialSignals');
  if (!wrap) return;
  wrap.innerHTML = '';
  const ss = state.socialSignals || {};
  ['facebook', 'instagram', 'threads'].forEach(p => {
    const s = ss[p] || { total: 0, red: 0, yellow: 0, green: 0, updated_at: '-' };
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'social-card';
    btn.setAttribute('aria-label', `${PLATFORM_LABEL[p]} 留言明細`);
    btn.innerHTML = `
      <h3>${PLATFORM_LABEL[p]}（總留言 ${s.total || 0}）</h3>
      <div class="social-row"><span class="tag">🔴 紅燈</span><strong>${s.red || 0}</strong></div>
      <div class="social-row"><span class="tag">🟡 黃燈</span><strong>${s.yellow || 0}</strong></div>
      <div class="social-row"><span class="tag">🟢 綠燈</span><strong>${s.green || 0}</strong></div>
      <div class="social-row" style="opacity:.75;font-size:12px"><span>更新</span><span>${escapeHtml(s.updated_at || '-')}</span></div>
      <div class="drill-hint">▸ 點擊查看完整留言</div>
    `;
    btn.addEventListener('click', () => openModal(p, 'all'));
    wrap.appendChild(btn);
  });
}

// --------- Red-ratio alert ---------
function updateAlertBanner(){
  const el = document.getElementById('alertBanner');
  if (!el) return;
  const ss = state.socialSignals || {};
  const redPlatforms = [];
  const warnPlatforms = [];
  ['facebook','instagram','threads'].forEach(p => {
    const s = ss[p] || {};
    const total = Number(s.total) || 0;
    if (!total) return;
    const redPct = total ? (Number(s.red) || 0) / total : 0;
    const nonGreenPct = total ? ((Number(s.red) || 0) + (Number(s.yellow) || 0)) / total : 0;
    if (redPct >= RED_RATIO_ALERT) redPlatforms.push({p, redPct});
    else if (nonGreenPct >= YELLOW_RATIO_WARN) warnPlatforms.push({p, nonGreenPct});
  });
  if (redPlatforms.length){
    el.classList.remove('hidden', 'level-yellow');
    el.classList.add('level-red');
    const chips = redPlatforms.map(x =>
      `<span class="chip">${PLATFORM_LABEL[x.p]} 紅 ${(x.redPct*100).toFixed(1)}%</span>`
    ).join('');
    el.innerHTML = `
      <span class="icon">🚨</span>
      <span class="msg">紅燈留言占比達警示門檻（≥${(RED_RATIO_ALERT*100)}%）。建議立即檢視紅燈留言清單。</span>
      <span class="platform-chips">${chips}</span>
    `;
  } else if (warnPlatforms.length){
    el.classList.remove('hidden', 'level-red');
    el.classList.add('level-yellow');
    const chips = warnPlatforms.map(x =>
      `<span class="chip">${PLATFORM_LABEL[x.p]} 非綠 ${(x.nonGreenPct*100).toFixed(1)}%</span>`
    ).join('');
    el.innerHTML = `
      <span class="icon">⚠️</span>
      <span class="msg">非綠燈（紅+黃）占比偏高，請關注輿情走向。</span>
      <span class="platform-chips">${chips}</span>
    `;
  } else {
    el.classList.add('hidden');
    el.classList.remove('level-red', 'level-yellow');
    el.innerHTML = '';
  }
}

// --------- Red-ratio trend chart (historical) ---------
function renderRedTrendChart(){
  const canvas = document.getElementById('redTrendChart');
  if (!canvas) return;
  const hist = state.history || {};
  const fmtLabel = (iso) => (iso || '').slice(5, 16).replace('T', ' ');

  // Build unified x-axis from the union of timestamps
  const allTs = new Set();
  ['facebook','instagram','threads'].forEach(p => (hist[p] || []).forEach(x => allTs.add(x.ts)));
  const labels = Array.from(allTs).sort();
  const series = {
    facebook: new Map((hist.facebook||[]).map(x => [x.ts, x.red_pct])),
    instagram: new Map((hist.instagram||[]).map(x => [x.ts, x.red_pct])),
    threads: new Map((hist.threads||[]).map(x => [x.ts, x.red_pct])),
  };
  const datasets = [
    { label: 'Facebook', color: '#4f8cff' },
    { label: 'Instagram', color: '#e83e8c' },
    { label: 'Threads', color: '#ffc107' },
  ].map(({label, color}) => {
    const key = label.toLowerCase();
    return {
      label,
      data: labels.map(ts => series[key].get(ts) ?? null),
      borderColor: color,
      backgroundColor: color + '33',
      tension: 0.3,
      spanGaps: true,
    };
  });

  redTrendChart = upsertChart(redTrendChart, canvas, {
    type: 'line',
    data: { labels: labels.map(fmtLabel), datasets },
    options: {
      plugins: { legend: { labels: { color: '#b9c3f2' } } },
      scales: {
        x: { ticks: { color: '#b9c3f2', maxRotation: 30 } },
        y: { ticks: { color: '#b9c3f2', callback: v => v + '%' }, beginAtZero: true, suggestedMax: 50 },
      },
    }
  });
}

// --------- Red comments panel (grouped by platform) ---------
function renderRedCommentsPanel(){
  const wrap = document.getElementById('redComments');
  if (!wrap) return;
  wrap.innerHTML = '';
  let anyShown = false;
  ['facebook','instagram','threads'].forEach(p => {
    const reds = (state.comments[p] || []).filter(c => c.signal === 'red');
    if (!reds.length) return;
    anyShown = true;
    const group = document.createElement('div');
    group.className = 'red-group';
    const title = document.createElement('h3');
    title.textContent = `${PLATFORM_LABEL[p]}（${reds.length} 則）`;
    group.appendChild(title);
    const ul = document.createElement('ul');
    reds.slice(0, 30).forEach(c => {
      const li = document.createElement('li');
      const authorHtml = `<span class="author">${escapeHtml(c.author || '匿名')}</span>` +
                        (c.time_text ? `<span class="when">（${escapeHtml(c.time_text)}）</span>` : '');
      let textHtml = escapeHtml(c.text || '');
      if (c.url) {
        textHtml = `<a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">${textHtml}</a>`;
      }
      li.innerHTML = `${authorHtml}<br/>${textHtml}`;
      ul.appendChild(li);
    });
    if (reds.length > 30) {
      const more = document.createElement('li');
      more.style.opacity = '.7';
      more.textContent = `... 另 ${reds.length - 30} 筆（點擊上方卡片查看完整清單）`;
      ul.appendChild(more);
    }
    group.appendChild(ul);
    wrap.appendChild(group);
  });
  if (!anyShown){
    wrap.innerHTML = '<p class="hint">目前無紅燈留言。</p>';
  }
}

// --------- Topic heat (Google Trends iframe + our-data chart) ---------
function buildTrendsIframeUrl(topic){
  const req = JSON.stringify({
    comparisonItem: [{ keyword: topic.trends_keyword, geo: topic.geo || 'TW', time: topic.time_range || 'today 5-y' }],
    category: 0,
    property: '',
  });
  return `https://trends.google.com/trends/embed/explore/TIMESERIES?req=${encodeURIComponent(req)}&hl=zh-TW&tz=-480`;
}

function renderTopicHeat(){
  const heat = state.topicHeat;
  if (!heat || !heat.topics || !heat.topics.length) return;
  const sel = document.getElementById('topicSelect');
  if (!sel) return;
  // Rebuild select options only if changed
  const existingIds = Array.from(sel.options).map(o => o.value).join(',');
  const newIds = heat.topics.map(t => t.id).join(',');
  if (existingIds !== newIds){
    sel.innerHTML = '';
    heat.topics.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.id; opt.textContent = t.label;
      sel.appendChild(opt);
    });
  }
  if (!state.selectedTopicId || !heat.topics.some(t => t.id === state.selectedTopicId)){
    state.selectedTopicId = heat.topics[0].id;
  }
  sel.value = state.selectedTopicId;
  const topic = heat.topics.find(t => t.id === state.selectedTopicId) || heat.topics[0];
  // Google Trends iframe
  const iframe = document.getElementById('topicTrendsIframe');
  if (iframe){
    const url = buildTrendsIframeUrl(topic);
    if (iframe.src !== url) iframe.src = url;
  }
  // Info text
  const info = document.getElementById('topicInfo');
  if (info){
    const total = topic.our_data?.total || 0;
    const kws = (topic.match_keywords || []).join('、');
    info.textContent = `（關鍵字：${kws}　我方共 ${total} 則）`;
  }
  // Our-data bar chart
  const canvas = document.getElementById('topicOwnChart');
  if (!canvas) return;
  const daily = topic.our_data?.daily || [];
  const labels = daily.map(d => d.date);
  const counts = daily.map(d => d.count);
  topicOwnChart = upsertChart(topicOwnChart, canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: `提及數（${topic.label}）`,
        data: counts,
        backgroundColor: '#4f8cff',
        borderRadius: 4,
      }],
    },
    options: {
      plugins: { legend: { labels: { color: '#b9c3f2' } } },
      scales: {
        x: { ticks: { color: '#b9c3f2' }, grid: { color: 'rgba(120,140,200,0.08)' } },
        y: { ticks: { color: '#b9c3f2', precision: 0 }, beginAtZero: true, grid: { color: 'rgba(120,140,200,0.08)' } },
      },
    },
  });
}

function initTopicHeat(){
  const sel = document.getElementById('topicSelect');
  if (sel && !sel.dataset.bound){
    sel.dataset.bound = '1';
    sel.addEventListener('change', () => {
      state.selectedTopicId = sel.value;
      renderTopicHeat();
    });
  }
}

// --------- Drilldown modal ---------
const modalState = { platform: 'facebook', filter: 'all' };

function openModal(platform, filter){
  modalState.platform = platform;
  modalState.filter = filter || 'all';
  const modal = document.getElementById('commentsModal');
  if (!modal) return;
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  document.getElementById('modalTitle').textContent = `${PLATFORM_LABEL[platform]} 留言明細`;
  // sync filter buttons
  document.querySelectorAll('#modalFilters .filter-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.filter === modalState.filter);
  });
  renderModalBody();
}

function closeModal(){
  const modal = document.getElementById('commentsModal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

function renderModalBody(){
  const body = document.getElementById('modalBody');
  const summary = document.getElementById('modalSummary');
  if (!body) return;
  const list = (state.comments[modalState.platform] || []);
  const filtered = modalState.filter === 'all'
    ? list
    : list.filter(c => c.signal === modalState.filter);
  const counts = { red: 0, yellow: 0, green: 0 };
  list.forEach(c => { if (counts[c.signal] != null) counts[c.signal]++; });
  if (summary) {
    summary.textContent = `共 ${list.length} 則（🔴 ${counts.red} / 🟡 ${counts.yellow} / 🟢 ${counts.green}）　｜　本視圖：${filtered.length} 則`;
  }
  body.innerHTML = '';
  if (!filtered.length){
    body.innerHTML = '<p class="hint" style="padding:20px;text-align:center">沒有符合條件的留言。</p>';
    return;
  }
  const frag = document.createDocumentFragment();
  filtered.forEach(c => {
    const div = document.createElement('div');
    div.className = 'comment-item';
    const lightClass = c.signal || 'green';
    const lightLabel = { red:'🔴 紅', yellow:'🟡 黃', green:'🟢 綠' }[lightClass] || lightClass;
    const url = c.url
      ? `<div class="linkrow"><a href="${escapeHtml(c.url)}" target="_blank" rel="noopener">原文連結 ↗</a></div>`
      : '';
    div.innerHTML = `
      <div class="hdr">
        <span class="author">${escapeHtml(c.author || '匿名')}</span>
        <span class="when">${escapeHtml(c.time_text || '')}</span>
        <span class="light-chip ${lightClass}">${lightLabel}</span>
      </div>
      <div class="text">${escapeHtml(c.text || '')}</div>
      ${url}
    `;
    frag.appendChild(div);
  });
  body.appendChild(frag);
}

function initModal(){
  const modal = document.getElementById('commentsModal');
  if (!modal) return;
  document.getElementById('modalClose')?.addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => {
    if (e.target?.dataset?.close === '1') closeModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeModal();
  });
  document.querySelectorAll('#modalFilters .filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      modalState.filter = btn.dataset.filter;
      document.querySelectorAll('#modalFilters .filter-btn').forEach(b => {
        b.classList.toggle('active', b === btn);
      });
      renderModalBody();
    });
  });
}

// --------- Main render ---------
async function run(){
  const d = await fetchJSON('./data.json');
  if (!d) return;

  // New signal/comment/history artefacts — optional, safe if absent
  state.socialSignals = await fetchJSON('./social_signals.json') || null;
  state.history = await fetchJSON('./social_signals_history.json') || { facebook: [], instagram: [], threads: [] };
  state.comments.facebook = await fetchJSON('./comments_facebook.json') || [];
  state.comments.instagram = await fetchJSON('./comments_instagram.json') || [];
  state.comments.threads = await fetchJSON('./comments_threads.json') || [];
  state.topicHeat = await fetchJSON('./topic_heat.json') || null;

  const m = pick(d, 'metrics', 'metrics_7d') || {};
  document.getElementById('updated').textContent = '更新時間：' + new Date(d.generated_at).toLocaleString('zh-TW',{hour12:false});
  document.getElementById('modeHint').textContent = mode==='7d' ? '（近7日聚合）' : '（近24h）';
  document.getElementById('total24').textContent = m.total ?? m.total_24h ?? '-';
  document.getElementById('prev24').textContent = m.prev ?? m.prev_24h ?? '-';
  document.getElementById('growth').textContent = m.growth_pct==null ? '-' : `${m.growth_pct}%`;
  document.getElementById('news24').textContent = m.news ?? m.news_24h ?? '-';

  const level = (m.anomaly||{}).level || '綠';
  document.getElementById('light').innerHTML = `<span class="badge ${level}">${LIGHT_ICON[level]||'🟢'} ${level}</span>`;

  const cmp = pick(d, 'mention_compare_24h', 'mention_compare_7d') || {};
  const names = Object.keys(cmp);
  const vals = names.map(n => cmp[n] || 0);
  document.getElementById('compare').textContent = names.map(n => `${n}：${cmp[n]||0}`).join(' ｜ ');

  const byPlatform = pick(d, 'by_platform', 'by_platform_7d') || [];
  const ul = document.getElementById('platforms'); ul.innerHTML='';
  byPlatform.forEach(x=>{ const li=document.createElement('li'); li.textContent=`${x.platform}: ${x.count}`; ul.appendChild(li); });

  // Clickable social cards + alert + trend chart + red panel — all read from state
  renderSocialCards();
  updateAlertBanner();
  renderRedTrendChart();
  renderRedCommentsPanel();
  renderTopicHeat();
  // If modal is open, re-render its body with fresh data
  const modal = document.getElementById('commentsModal');
  if (modal && !modal.classList.contains('hidden')) renderModalBody();

  const topNews = pick(d, 'top_news', 'top_news_7d') || [];
  const news = document.getElementById('news'); news.innerHTML='';
  const displayText = (x)=>{
    const t=(x.title||'').trim();
    if(t) return t;
    try{ return new URL(x.url).hostname + '（原文）'; }catch{ return '來源連結'; }
  };
  topNews.slice(0,12).forEach(x=>{
    const li=document.createElement('li');
    const a=document.createElement('a');
    a.href=x.url; a.target='_blank'; a.rel='noopener';
    a.textContent=displayText(x) + (x.time ? `（${x.time.slice(5,16)}）` : '');
    li.appendChild(a); news.appendChild(li);
  });

  const detailMap = pick(d, 'latest_by_platform_24h', 'latest_by_platform_7d') || {};
  const platformDetail = document.getElementById('platformDetail');
  if(platformDetail){
    platformDetail.innerHTML='';
    Object.keys(detailMap).forEach(p=>{
      const box=document.createElement('div'); box.className='platform-box';
      const h=document.createElement('h3'); h.textContent=`${p}（${(detailMap[p]||[]).length} 筆）`; box.appendChild(h);
      const ol=document.createElement('ol');
      (detailMap[p]||[]).forEach(x=>{
        const li=document.createElement('li');
        const a=document.createElement('a'); a.href=x.url; a.target='_blank'; a.rel='noopener';
        a.textContent=displayText(x) + (x.time ? `（${x.time.slice(5,16)}）` : '');
        li.appendChild(a); ol.appendChild(li);
      });
      box.appendChild(ol); platformDetail.appendChild(box);
    });
  }

  function renderList(elId, arr){
    const el=document.getElementById(elId); if(!el) return; el.innerHTML='';
    (arr||[]).forEach(x=>{ const li=document.createElement('li'); const a=document.createElement('a'); a.href=x.url; a.target='_blank'; a.rel='noopener'; a.textContent=displayText(x)+(x.time?`（${x.time.slice(5,16)}）`:'' ); li.appendChild(a); el.appendChild(li); });
  }
  const ps = d.person_sections || {};
  renderList('luFb', (ps['盧秀燕']||{}).facebook || []);
  renderList('luNews', (ps['盧秀燕']||{}).news || []);
  renderList('chiangFb', (ps['蔣萬安']||{}).facebook || []);
  renderList('chiangNews', (ps['蔣萬安']||{}).news || []);
  renderList('chenFb', (ps['陳其邁']||{}).facebook || []);
  renderList('chenNews', (ps['陳其邁']||{}).news || []);
  renderList('tsaiFb', (ps['蔡其昌']||{}).facebook || []);
  renderList('tsaiNews', (ps['蔡其昌']||{}).news || []);

  const byHour = pick(d, 'by_hour', 'by_hour_7d') || [];

  // 燈號狀態與原因（可視化）
  const an = m.anomaly || {};
  const reasons = an.reasons || [];
  const es = d.event_stream || {};
  const streamTxt = `分鐘級 ${ (es.minute||[]).length }｜小時級 ${ (es.hour||[]).length }｜日級 ${ (es.day||[]).length }`;
  const ls = document.getElementById('lightStatus');
  if(ls){ ls.innerHTML = `<span class="badge ${level}">${LIGHT_ICON[level]||'🟢'} 今日燈號：${level}</span>`; }
  const lr = document.getElementById('lightReasons');
  if(lr){ lr.textContent = reasons.length ? `觸發原因：${reasons.join('；')}` : '觸發原因：無（目前屬常態）'; }
  const lstream = document.getElementById('lightStreams');
  if(lstream){ lstream.innerHTML = `<span class="badge 綠">${streamTxt}</span>`; }
  const lt = document.getElementById('lightTrend');
  if(lt){
    const avg = byHour.length ? byHour.reduce((a,b)=>a+(b.count||0),0)/byHour.length : 0;
    const last = byHour.slice(-12).map(x => ({ h:(x.hour||'').slice(11,16), lv: lightLevelByCount(x.count||0, avg) }));
    lt.innerHTML = '近12小時：' + last.map(x=>`${x.h} ${LIGHT_ICON[x.lv]}${x.lv}`).join(' ｜ ');
  }

  hourChart = upsertChart(hourChart, document.getElementById('hourChart'), {
    type:'line',
    data:{ labels:byHour.map(x=>(x.hour||'').slice(5,16)), datasets:[{label:'mentions', data:byHour.map(x=>x.count||0), borderColor:'#7fc0ff', backgroundColor:'rgba(127,192,255,0.2)', tension:0.25, fill:true}] },
    options:{plugins:{legend:{display:false}}, scales:{x:{ticks:{color:'#b9c3f2'}}, y:{ticks:{color:'#b9c3f2'}}}}
  });

  platformChart = upsertChart(platformChart, document.getElementById('platformChart'), {
    type:'doughnut',
    data:{ labels:byPlatform.map(x=>x.platform), datasets:[{data:byPlatform.map(x=>x.count), backgroundColor:['#4f8cff','#20c997','#ffc107','#e83e8c','#fd7e14','#6f42c1','#adb5bd']}] },
    options:{plugins:{legend:{labels:{color:'#b9c3f2'}}}}
  });

  mentionChart = upsertChart(mentionChart, document.getElementById('mentionChart'), {
    type:'bar',
    data:{ labels:names, datasets:[{data:vals, backgroundColor:['#20c997','#4f8cff','#ffc107','#e83e8c','#fd7e14']}] },
    options:{plugins:{legend:{display:false}}, scales:{x:{ticks:{color:'#b9c3f2'}}, y:{ticks:{color:'#b9c3f2'}}}}
  });
}

function initCollapsibles(){
  document.querySelectorAll('.panel-toggle').forEach(btn=>{
    if(btn.dataset.bound==='1') return;
    btn.dataset.bound='1';
    btn.addEventListener('click', ()=>{
      const expanded = btn.getAttribute('aria-expanded') === 'true';
      btn.setAttribute('aria-expanded', String(!expanded));
      const panel = btn.closest('.collapsible');
      if(panel) panel.classList.toggle('collapsed', expanded);
    });
  });
}

function initModes(){
  const b24 = document.getElementById('mode24');
  const b7 = document.getElementById('mode7d');
  if(b24) b24.onclick = async ()=>{ mode='24h'; await run(); };
  if(b7) b7.onclick = async ()=>{ mode='7d'; await run(); };
}

initCollapsibles();
initModes();
initModal();
initTopicHeat();
run();
setInterval(run,60000);
