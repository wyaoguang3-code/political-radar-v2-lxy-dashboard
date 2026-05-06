let hourChart, platformChart, mentionChart, redTrendChart, topicOwnChart, topicTrendsChart;
let incidentMap;
let mode = '24h';

// In-memory cache of the latest fetched comment lists + history, so the modal
// and the red-list panel don't need to re-fetch on every interaction.
const state = {
  socialSignals: null,
  comments: { facebook: [], instagram: [], threads: [] },
  history: { facebook: [], instagram: [], threads: [] },
  topicHeat: null,
  selectedTopicId: null,
  mentionArticles: {},
};

const LIGHT_ICON = { '紅':'🔴', '黃':'🟡', '綠':'🟢' };
const PLATFORM_LABEL = { facebook: 'Facebook', instagram: 'Instagram', threads: 'Threads' };
const RED_RATIO_ALERT = 0.25;     // 25%: show red banner
const YELLOW_RATIO_WARN = 0.40;   // 40% non-green: yellow banner

const DEFAULT_HOTSPOTS = [
  {
    title: '台中槍案',
    place: '台中市西區府後街',
    lat: 24.1388,
    lng: 120.6697,
    level: 'red',
    source: 'news',
    platform: '新聞',
    note: '社會治安高關注事件'
  }
];

const COMMENT_EVENT_RULES = [
  {
    title: '廚餘山',
    place: '台中市霧峰區',
    lat: 24.046,
    lng: 120.698,
    level: 'red',
    keywords: ['廚餘山', '廚餘']
  },
  {
    title: '垃圾山',
    place: '台中市大里區',
    lat: 24.104,
    lng: 120.69,
    level: 'red',
    keywords: ['垃圾山', '垃圾掩埋場']
  },
  {
    title: '捷運藍線爭議',
    place: '台中市政府（西屯）',
    lat: 24.1617,
    lng: 120.6469,
    level: 'yellow',
    keywords: ['捷運', '藍線']
  },
  {
    title: '行人地獄討論',
    place: '台中市中區',
    lat: 24.1402,
    lng: 120.6839,
    level: 'yellow',
    keywords: ['行人地獄']
  }
];

const LOCATION_HINTS = [
  { k: '府後街', place: '台中市西區府後街', lat: 24.1388, lng: 120.6697 },
  { k: '霧峰', place: '台中市霧峰區', lat: 24.046, lng: 120.698 },
  { k: '大里', place: '台中市大里區', lat: 24.104, lng: 120.69 },
  { k: '西屯', place: '台中市西屯區', lat: 24.1818, lng: 120.6252 },
  { k: '西區', place: '台中市西區', lat: 24.1437, lng: 120.6626 }
];

function lightLevelByCount(c, avg){
  if(c >= Math.max(10, avg*1.8)) return '紅';
  if(c >= Math.max(5, avg*1.2)) return '黃';
  return '綠';
}

// 結合「聲量 (volume)」與「該時段內負面新聞比例」— 取較嚴重者。
// 解決外面綠燈裡面有負面新聞 的不一致，但用「比例 + 絕對數」雙門檻避免
// 1 則負面新聞就把整天/整小時拉成黃 — 比例不夠不算。
const LIGHT_RANK = { '綠': 0, '黃': 1, '紅': 2 };
function severityOf(a){
  return a.severity || (a.is_negative ? 'yellow' : null);
}
function severityLightOf(articles){
  const arts = articles || [];
  const total = arts.length;
  let reds = 0, yellows = 0;
  for (const a of arts){
    const s = severityOf(a);
    if (s === 'red') reds++;
    else if (s === 'yellow') yellows++;
  }
  const neg = reds + yellows;
  if (total === 0) return '綠';
  // 紅：≥3 紅 OR （≥2 紅且紅比例 ≥25%）
  if (reds >= 3 || (reds >= 2 && reds / total >= 0.25)) return '紅';
  // 黃：≥5 負面 OR （≥3 負面且負面比例 ≥30%）
  if (neg >= 5 || (neg >= 3 && neg / total >= 0.30)) return '黃';
  return '綠';
}
function combineLights(volumeLight, articles){
  const sevLight = severityLightOf(articles);
  return LIGHT_RANK[volumeLight] >= LIGHT_RANK[sevLight] ? volumeLight : sevLight;
}

function upsertChart(instance, ctx, config){
  // 若 type 變了（例如 line ↔ bar），必須 destroy + 重建；否則只更新 data/options。
  if(instance && instance.config && instance.config.type === config.type){
    instance.data=config.data; instance.options=config.options; instance.update(); return instance;
  }
  if(instance) instance.destroy();
  return new Chart(ctx, config);
}

// Shared tooltip style matching the dashboard's dark theme.
// Pass { callbacks: {...}, mode, displayColors } etc. to override.
function darkTooltip(overrides){
  return Object.assign({
    backgroundColor: 'rgba(18, 25, 53, 0.96)',
    borderColor: '#5a79ff',
    borderWidth: 1,
    titleColor: '#d8e2ff',
    bodyColor: '#e8ecff',
    padding: 10,
    cornerRadius: 8,
    titleFont: { weight: '600', size: 13 },
    bodyFont: { size: 13 },
    displayColors: true,      // default true so multi-series charts still show color dots
    intersect: false,
  }, overrides || {});
}

// For line/bar charts with a time/category x-axis: "hover anywhere on x" behavior.
const INDEX_HOVER = { mode: 'index', intersect: false, axis: 'x' };

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

  // Enhance dataset styling for nicer hover markers
  datasets.forEach(ds => {
    ds.pointRadius = 0;
    ds.pointHoverRadius = 5;
    ds.pointHoverBackgroundColor = '#fff';
    ds.pointHoverBorderColor = ds.borderColor;
    ds.pointHoverBorderWidth = 2;
    ds.borderWidth = 1.8;
  });
  redTrendChart = upsertChart(redTrendChart, canvas, {
    type: 'line',
    data: { labels: labels.map(fmtLabel), datasets },
    options: {
      interaction: INDEX_HOVER,
      hover: INDEX_HOVER,
      plugins: {
        legend: { labels: { color: '#b9c3f2' } },
        tooltip: darkTooltip({
          mode: 'index',
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}：${ctx.parsed.y == null ? '—' : ctx.parsed.y.toFixed(1) + '%'}`,
          },
        }),
      },
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
// Link to the public Google Trends explore page (opens in a new tab).
// trends.google.com blocks iframe embedding from most origins, so we link out
// instead of iframing — cleaner and always works.
function buildTrendsExploreUrl(topic){
  const q = encodeURIComponent(topic.trends_keyword);
  const geo = encodeURIComponent(topic.geo || 'TW');
  const date = encodeURIComponent(topic.time_range || 'today 5-y');
  return `https://trends.google.com/trends/explore?date=${date}&geo=${geo}&q=${q}&hl=zh-TW`;
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
  // Google Trends external link (interactive version, opens in new tab)
  const link = document.getElementById('topicTrendsLink');
  const linkLabel = document.getElementById('topicTrendsLinkLabel');
  if (link){
    link.href = buildTrendsExploreUrl(topic);
    if (linkLabel) linkLabel.textContent = `在 Google Trends 查看「${topic.label}」互動版`;
  }
  // Google Trends inline line chart (5y weekly series fetched by pytrends)
  renderTrendsChart(topic);
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
        hoverBackgroundColor: '#7fc0ff',
        borderRadius: 4,
      }],
    },
    options: {
      interaction: INDEX_HOVER,
      hover: INDEX_HOVER,
      plugins: {
        legend: { labels: { color: '#b9c3f2' } },
        tooltip: darkTooltip({
          mode: 'index',
          displayColors: false,
          callbacks: {
            title: (items) => items[0]?.label || '',
            label: (ctx) => `提及：${ctx.parsed.y} 則`,
          },
        }),
      },
      scales: {
        x: { ticks: { color: '#b9c3f2' }, grid: { color: 'rgba(120,140,200,0.08)' } },
        y: { ticks: { color: '#b9c3f2', precision: 0 }, beginAtZero: true, grid: { color: 'rgba(120,140,200,0.08)' } },
      },
    },
  });
}

function renderTrendsChart(topic){
  const canvas = document.getElementById('topicTrendsChart');
  const meta = document.getElementById('topicTrendsMeta');
  if (!canvas) return;
  const gt = topic.google_trends;
  if (!gt || !gt.points || !gt.points.length){
    // Nothing to draw — clear canvas and show a note
    if (topicTrendsChart){ topicTrendsChart.destroy(); topicTrendsChart = null; }
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (meta) meta.innerHTML = '<span class="trends-warn">⚠️ Google Trends 尚未取得資料（可能 Google 暫時封鎖 pytrends）。請稍後重跑 <code>update_topic_heat_lxy.py</code>。</span>';
    return;
  }
  const pts = gt.points;
  const labels = pts.map(p => p.date);
  const values = pts.map(p => p.value);
  const peak = values.reduce((a,b) => a > b ? a : b, 0);
  const peakIdx = values.indexOf(peak);
  const peakDate = labels[peakIdx];
  topicTrendsChart = upsertChart(topicTrendsChart, canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: `${topic.label} 熱度 (0–100)`,
        data: values,
        borderColor: '#7fc0ff',
        backgroundColor: 'rgba(127,192,255,0.18)',
        fill: true,
        tension: 0.15,
        pointRadius: 0,           // baseline: dots hidden for a clean line
        pointHoverRadius: 5,      // highlight the point under the cursor
        pointHoverBackgroundColor: '#ffffff',
        pointHoverBorderColor: '#7fc0ff',
        pointHoverBorderWidth: 2,
        borderWidth: 1.8,
      }],
    },
    options: {
      // Index mode: hover anywhere on the x-axis shows the nearest week's
      // tooltip (instead of requiring a pixel-exact hover on a data point).
      interaction: { mode: 'index', intersect: false, axis: 'x' },
      hover: { mode: 'index', intersect: false },
      plugins: {
        legend: { labels: { color: '#b9c3f2' } },
        tooltip: {
          mode: 'index',
          intersect: false,
          backgroundColor: 'rgba(18, 25, 53, 0.96)',
          borderColor: '#5a79ff',
          borderWidth: 1,
          titleColor: '#d8e2ff',
          bodyColor: '#e8ecff',
          padding: 10,
          cornerRadius: 8,
          titleFont: { weight: '600', size: 13 },
          bodyFont: { size: 13 },
          displayColors: false,
          callbacks: {
            title: (items) => items[0]?.label || '',
            label: (ctx) => `熱度：${ctx.parsed.y} / 100`,
          },
        },
      },
      scales: {
        x: {
          ticks: {
            color: '#b9c3f2',
            maxTicksLimit: 8,   // 262 個點，Chart.js 自動挑子集顯示 label
            maxRotation: 0,
            autoSkip: true,
          },
          grid: { color: 'rgba(120,140,200,0.06)' },
        },
        y: {
          beginAtZero: true, suggestedMax: 100,
          ticks: { color: '#b9c3f2', stepSize: 25 },
          grid: { color: 'rgba(120,140,200,0.08)' },
        },
      },
    },
  });
  canvas.style.cursor = 'crosshair';   // affordance: hints the line is interactive
  if (meta){
    const fetched = gt.fetched_at ? new Date(gt.fetched_at).toLocaleString('zh-TW', { hour12: false }) : '—';
    const stale = gt.stale ? `<span class="trends-warn">（快取資料，最新一次 fetch 失敗）</span>` : '';
    meta.innerHTML = `
      共 ${pts.length} 筆（週頻率）　｜　峰值 <b>${peak}</b> @ ${peakDate}　｜　抓取時間：${fetched} ${stale}
    `;
  }
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

function inferLocationFromText(text){
  const t = String(text || '');
  const hit = LOCATION_HINTS.find(x => t.includes(x.k));
  return hit || null;
}

function deriveCommentHotspots(){
  const out = [];
  COMMENT_EVENT_RULES.forEach(rule => {
    const platforms = new Set();
    let hits = 0;
    let inferred = null;

    ['facebook','instagram','threads'].forEach(p => {
      (state.comments[p] || []).forEach(c => {
        const txt = String(c.text || '');
        if (rule.keywords.some(k => txt.includes(k))) {
          hits += 1;
          platforms.add(PLATFORM_LABEL[p] || p);
          if (!inferred) inferred = inferLocationFromText(txt);
        }
      });
    });

    if (hits > 0) {
      out.push({
        title: rule.title,
        place: inferred?.place || rule.place,
        lat: inferred?.lat ?? rule.lat,
        lng: inferred?.lng ?? rule.lng,
        level: rule.level,
        source: 'comment',
        platform: `留言：${Array.from(platforms).join(' / ')}`,
        note: `自動偵測 ${hits} 則相關留言`
      });
    }
  });
  return out;
}

function formatLifetimeHint(h){
  const newsCount = h.news_count || 0;
  const commentCount = h.comment_count || 0;
  const expiresIso = h.news_full_expires_at;

  if (newsCount > 0 && expiresIso){
    const expires = new Date(expiresIso).getTime();
    const now = Date.now();
    const hoursLeft = Math.max(0, (expires - now) / 3600000);
    const hoursStr = hoursLeft >= 1 ? `${hoursLeft.toFixed(0)} 小時` : '不到 1 小時';
    if (commentCount > 0){
      return `預估新聞訊號 ${hoursStr}後完全退場（留言訊號可能延長壽命）`;
    }
    return `預估 ${hoursStr}後完全退場（新聞滑出 24h 窗）`;
  }

  if (commentCount > 0){
    return `依粉專留言下一次抓取結果調整（每小時更新）`;
  }
  return '';
}

function renderIncidentMap(d){
  const mapEl = document.getElementById('incidentMap');
  if (!mapEl || typeof window.L === 'undefined') return;

  let hotspots = (Array.isArray(d.hotspots) && d.hotspots.length) ? d.hotspots : [];
  if (!hotspots.length) {
    const autoCommentHotspots = deriveCommentHotspots();
    hotspots = [...DEFAULT_HOTSPOTS, ...(autoCommentHotspots.length ? autoCommentHotspots : COMMENT_EVENT_RULES.map(r => ({
      title: r.title,
      place: r.place,
      lat: r.lat,
      lng: r.lng,
      level: r.level,
      source: 'comment',
      platform: '留言（暫無偵測到平台）',
      note: '等待留言資料觸發'
    })))];

    const suggestEl = document.getElementById('hotspotSuggestions');
    if (suggestEl) {
      const pending = COMMENT_EVENT_RULES.filter(r => !autoCommentHotspots.some(h => h.title === r.title));
      suggestEl.innerHTML = pending.length
        ? `半自動建議：以下事件目前尚未在最新留言中達到觸發條件 → ${pending.map(x => `<span class="chip">${escapeHtml(x.title)}</span>`).join('')}`
        : '半自動建議：目前規則事件皆已觸發。';
    }
  }

  if (hotspots.length && Array.isArray(d.hotspots) && d.hotspots.length) {
    const suggestEl = document.getElementById('hotspotSuggestions');
    if (suggestEl) suggestEl.textContent = '目前採用 data.json 既有 hotspots 設定（手動/外部來源）。';
  }

  if (!incidentMap) {
    incidentMap = L.map('incidentMap', { scrollWheelZoom: false }).setView([24.15, 120.67], 11);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution: '&copy; OpenStreetMap'
    }).addTo(incidentMap);
  }

  if (incidentMap._markerLayer) incidentMap.removeLayer(incidentMap._markerLayer);
  const layer = L.featureGroup();
  const markersByTitle = {};

  hotspots.forEach(h => {
    if (h.lat == null || h.lng == null) return;
    const level = h.level || 'red';
    const color = level === 'red' ? '#ff4d4f' : level === 'yellow' ? '#f7c948' : '#20c997';
    const marker = L.circleMarker([h.lat, h.lng], {
      radius: 9,
      color,
      weight: 2,
      fillColor: color,
      fillOpacity: 0.65
    });
    const lifetime = formatLifetimeHint(h);
    marker.bindPopup(`
      <div class="map-popup">
        <strong>${escapeHtml(h.title || '事件')}</strong><br/>
        地點：${escapeHtml(h.place || '-') }<br/>
        等級：${escapeHtml(level.toUpperCase())}<br/>
        來源：${escapeHtml(h.source || '-') }<br/>
        平台：${escapeHtml(h.platform || '-') }<br/>
        備註：${escapeHtml(h.note || '-') }
        ${lifetime ? `<br/><span class="lifetime-hint">⏳ ${escapeHtml(lifetime)}</span>` : ''}
      </div>
    `);
    if (h.title) markersByTitle[h.title] = marker;
    layer.addLayer(marker);
  });

  layer.addTo(incidentMap);
  incidentMap._markerLayer = layer;

  const bounds = layer.getBounds();
  if (bounds.isValid()) incidentMap.fitBounds(bounds.pad(0.25));

  renderHotspotCards(hotspots, markersByTitle);
}

function renderHotspotCards(hotspots, markersByTitle){
  const container = document.getElementById('hotspotList');
  const summary = document.getElementById('hotspotSummary');
  if (!container) return;
  container.innerHTML = '';

  const list = Array.isArray(hotspots) ? hotspots : [];

  // 摘要列：🔴 X / 🟡 Y / 🟢 Z + 🚨 緊急 N
  if (summary){
    const counts = { red: 0, yellow: 0, green: 0 };
    let urgent = 0;
    list.forEach(h => {
      if (counts[h.level] != null) counts[h.level] += 1;
      if (h.is_urgent) urgent += 1;
    });
    const urgentPart = urgent > 0 ? `　🚨 緊急 ${urgent} 件` : '';
    summary.textContent = `🔴 ${counts.red}　🟡 ${counts.yellow}　🟢 ${counts.green}${urgentPart}`;
  }

  if (!list.length){
    container.innerHTML = '<p class="hint">目前沒有偵測到熱點事件。</p>';
    return;
  }

  // 依城市分組
  // 顯示順序：盧秀燕主場（台中）首位 → 6 都 → 3 省轄市 → 13 縣 → 其他
  const CITY_ORDER = [
    '台中',
    '台北', '新北', '桃園', '台南', '高雄',
    '基隆', '新竹市', '嘉義市',
    '新竹縣', '苗栗', '彰化', '南投', '雲林', '嘉義縣',
    '屏東', '宜蘭', '花蓮', '台東',
    '澎湖', '金門', '連江',
    '其他',
  ];
  const groups = {};
  list.forEach(h => {
    const city = h.city || '其他';
    (groups[city] = groups[city] || []).push(h);
  });

  // 每城市內排序：緊急 > 級別（紅黃綠）> urgency_score 降冪
  const levelOrder = { red: 0, yellow: 1, green: 2 };
  const sortInCity = arr => arr.sort((a, b) => {
    if (!!a.is_urgent !== !!b.is_urgent) return a.is_urgent ? -1 : 1;
    const av = levelOrder[a.level] ?? 9;
    const bv = levelOrder[b.level] ?? 9;
    if (av !== bv) return av - bv;
    return (b.urgency_score || 0) - (a.urgency_score || 0);
  });

  const renderCity = (city) => {
    const arr = groups[city];
    if (!arr || !arr.length) return;
    sortInCity(arr);

    const section = document.createElement('div');
    section.className = 'hotspot-city-section';

    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'hotspot-city-header';
    header.setAttribute('aria-expanded', 'true');
    const counts = { red: 0, yellow: 0, green: 0 };
    let urgent = 0;
    arr.forEach(h => {
      if (counts[h.level] != null) counts[h.level] += 1;
      if (h.is_urgent) urgent += 1;
    });
    header.innerHTML = `
      <span class="city-arrow">▾</span>
      <h4>${escapeHtml(city)}</h4>
      <span class="city-counts">
        ${urgent ? `<span class="city-urgent">🚨 ${urgent} 件待處理</span>　` : ''}
        🔴 ${counts.red}　🟡 ${counts.yellow}　🟢 ${counts.green}
      </span>
    `;
    header.addEventListener('click', () => {
      const collapsed = section.classList.toggle('collapsed');
      header.setAttribute('aria-expanded', String(!collapsed));
    });
    section.appendChild(header);

    const grid = document.createElement('div');
    grid.className = 'hotspot-list';

    arr.forEach(h => {
      const level = h.level || 'green';
      const card = document.createElement('div');
      card.className = `hotspot-card level-${level}${h.is_urgent ? ' urgent' : ''}`;
      card.dataset.title = h.title || '';
      const total = (h.news_count || 0) + (h.comment_count || 0);
      const lifetime = formatLifetimeHint(h);
      const sourceTag = (h.news_count || 0) > 0 && (h.comment_count || 0) > 0 ? '混合'
                      : (h.news_count || 0) > 0 ? '新聞主導'
                      : '留言主導';
      const negPart = (h.news_count || 0) > 0
        ? `<span class="hc-negativity ${h.negativity_pct >= 50 ? 'high' : h.negativity_pct >= 25 ? 'mid' : 'low'}">${h.negativity_pct || 0}% 負面</span>`
        : '';
      const urgentBadge = h.is_urgent ? '<span class="hc-urgent-badge">🚨 緊急</span>' : '';
      card.innerHTML = `
        <div class="hc-row1">
          <span class="hc-level-chip ${level}">${level.toUpperCase()}</span>
          <span class="hc-title">${escapeHtml(h.title || '事件')}</span>
          ${urgentBadge}
        </div>
        <div class="hc-row2">
          <span class="hc-count">${total} 則</span>
          ${negPart}
          <span class="hc-source-tag">${sourceTag}</span>
        </div>
        <div class="hc-place">📍 ${escapeHtml(h.place || '-')}</div>
        <div class="hc-platform">${escapeHtml(h.platform || '')}</div>
        ${lifetime ? `<div class="hc-lifetime">⏳ ${escapeHtml(lifetime)}</div>` : ''}
      `;
      card.addEventListener('click', () => {
        openHotspotDetailModal(h, markersByTitle);
      });
      grid.appendChild(card);
    });

    section.appendChild(grid);
    container.appendChild(section);
  };

  CITY_ORDER.forEach(renderCity);
  // 任何沒在 CITY_ORDER 列出的城市
  Object.keys(groups).forEach(city => {
    if (!CITY_ORDER.includes(city)) renderCity(city);
  });
}

// --------- Past events history ---------
const PAST_EVENTS_DEFAULT_LIMIT = 14;  // 預設顯示近 14 天
let _pastEventsAll = [];               // cached全部 days，分頁時用
let _pastEventsShown = 0;

async function renderPastEvents(){
  const wrap = document.getElementById('pastEventsWrap');
  const list = document.getElementById('pastEventsList');
  const meta = document.getElementById('pastEventsMeta');
  if (!wrap || !list) return;

  const hist = await fetchJSON('./hotspot_history.json');
  if (!hist || !Array.isArray(hist.days) || hist.days.length === 0){
    if (meta) meta.textContent = '（暫無歷史資料）';
    list.innerHTML = '';
    return;
  }

  // 倒序：最新日期在最上
  _pastEventsAll = [...hist.days].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  _pastEventsShown = 0;
  if (meta) meta.textContent = `（共 ${_pastEventsAll.length} 天紀錄，預設顯示近 ${PAST_EVENTS_DEFAULT_LIMIT} 天）`;

  list.innerHTML = '';
  appendPastEventsBatch(PAST_EVENTS_DEFAULT_LIMIT);
}

function appendPastEventsBatch(count){
  const list = document.getElementById('pastEventsList');
  if (!list) return;

  // 如果之前有「載入更多」按鈕，先移除
  list.querySelectorAll('.past-load-more').forEach(b => b.remove());

  const end = Math.min(_pastEventsShown + count, _pastEventsAll.length);
  const PAST_CITY_ORDER = [
    '台中',
    '台北', '新北', '桃園', '台南', '高雄',
    '基隆', '新竹市', '嘉義市',
    '新竹縣', '苗栗', '彰化', '南投', '雲林', '嘉義縣',
    '屏東', '宜蘭', '花蓮', '台東',
    '澎湖', '金門', '連江',
    '其他',
  ];

  // 「今日」用台北時區判斷（後端 d.date 也是台北日期），避免 UTC vs +8 跨日誤標
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });

  for (let i = _pastEventsShown; i < end; i++){
    const d = _pastEventsAll[i];
    const dayWrap = document.createElement('div');
    dayWrap.className = 'past-day';

    const hs = d.hotspots || [];
    const counts = { red: 0, yellow: 0, green: 0 };
    let urgent = 0;
    hs.forEach(h => {
      if (counts[h.level] != null) counts[h.level] += 1;
      if (h.is_urgent) urgent += 1;
    });

    const isToday = d.date === todayStr;
    const dateLabel = isToday ? `${d.date}（今日）` : d.date;
    const dayHeader = document.createElement('button');
    dayHeader.type = 'button';
    dayHeader.className = 'past-day-header';
    dayHeader.setAttribute('aria-expanded', 'true');
    dayHeader.innerHTML = `
      <span class="past-day-arrow">▾</span>
      <span class="past-day-date">${escapeHtml(dateLabel)}</span>
      <span class="past-day-counts">
        ${urgent ? `<span class="past-urgent">🚨 ${urgent}</span>　` : ''}
        🔴 ${counts.red}　🟡 ${counts.yellow}　🟢 ${counts.green}
      </span>
    `;
    dayHeader.addEventListener('click', () => {
      const collapsed = dayWrap.classList.toggle('collapsed');
      dayHeader.setAttribute('aria-expanded', String(!collapsed));
    });
    dayWrap.appendChild(dayHeader);

    // 依城市分組
    const byCity = {};
    hs.forEach(h => {
      const city = h.city || '其他';
      (byCity[city] = byCity[city] || []).push(h);
    });

    const renderPastCity = (city) => {
      const arr = byCity[city];
      if (!arr || !arr.length) return;
      const cityCnts = { red: 0, yellow: 0, green: 0 };
      let cityUrg = 0;
      arr.forEach(h => {
        if (cityCnts[h.level] != null) cityCnts[h.level] += 1;
        if (h.is_urgent) cityUrg += 1;
      });

      const citySec = document.createElement('div');
      citySec.className = 'past-city-section';
      // 預設展開；點 header 可收合
      const headerBtn = document.createElement('button');
      headerBtn.type = 'button';
      headerBtn.className = 'past-city-header';
      headerBtn.setAttribute('aria-expanded', 'true');
      headerBtn.innerHTML = `
        <span class="past-city-arrow">▾</span>
        <span class="past-city-name">${escapeHtml(city)}</span>
        <span class="past-city-counts">
          ${cityUrg ? `<span class="past-urgent">🚨 ${cityUrg}</span>　` : ''}
          🔴 ${cityCnts.red}　🟡 ${cityCnts.yellow}　🟢 ${cityCnts.green}
        </span>
      `;
      citySec.appendChild(headerBtn);

      const ul = document.createElement('ul');
      ul.className = 'past-day-events';
      [...arr].sort((a, b) => (b.urgency_score || 0) - (a.urgency_score || 0)).forEach(h => {
        const li = document.createElement('li');
        li.className = 'past-event-item';
        const level = h.level || 'green';
        const total = (h.news_count || 0) + (h.comment_count || 0);
        const urgentMark = h.is_urgent ? '🚨 ' : '';
        const sample = (h.sample_titles || [])
          .filter(t => t)
          .slice(0, 2)
          .map(t => `<div class="past-sample">・${escapeHtml(t)}</div>`)
          .join('');
        li.innerHTML = `
          <div class="past-event-row">
            <span class="hc-level-chip ${level}">${level.toUpperCase()}</span>
            <span class="past-event-title">${urgentMark}${escapeHtml(h.title || '事件')}</span>
            <span class="past-event-count">${total} 則${h.negativity_pct ? ` · ${h.negativity_pct}% 負面` : ''}</span>
          </div>
          ${sample}
        `;
        li.addEventListener('click', () => openPastEventModal(h, d.date));
        ul.appendChild(li);
      });
      citySec.appendChild(ul);

      // toggle：點 header 收合/展開
      headerBtn.addEventListener('click', () => {
        const collapsed = citySec.classList.toggle('collapsed');
        headerBtn.setAttribute('aria-expanded', String(!collapsed));
      });

      dayWrap.appendChild(citySec);
    };

    PAST_CITY_ORDER.forEach(renderPastCity);
    Object.keys(byCity).forEach(city => {
      if (!PAST_CITY_ORDER.includes(city)) renderPastCity(city);
    });

    list.appendChild(dayWrap);
  }
  _pastEventsShown = end;

  // 還有更多 → 加「載入更多」按鈕
  if (_pastEventsShown < _pastEventsAll.length){
    const remaining = _pastEventsAll.length - _pastEventsShown;
    const btn = document.createElement('button');
    btn.className = 'past-load-more';
    btn.type = 'button';
    btn.textContent = `▾ 顯示更多（還有 ${remaining} 天）`;
    btn.addEventListener('click', () => appendPastEventsBatch(30));
    list.appendChild(btn);
  }
}

// 每天 archive 的記憶體 cache（避免重複 fetch 同一天）
const _pastArchiveCache = {};

// 把任意 articles 陣列開到既有 hotspot detail modal
// 純清單用途（卡片/圖表 click），沒 level/place/壽命概念，meta 只顯示 note
function openArticlesModal(title, note, articles){
  const news = (articles || []).map(a => ({
    title: a.title || '（無標題）',
    url: a.url || '',
    time: a.time || '',
    is_negative: !!a.is_negative,
    severity: a.severity || (a.is_negative ? 'yellow' : null),  // 沒 severity 的舊資料退回二級
  }));
  openHotspotDetailModal({
    // openHotspotDetailModal 會自動在標題後綴 (N 則)，所以這裡只傳乾淨的 title
    title: title,
    note: note,
    news_count: news.length,
    comment_count: 0,
    news_articles: news,
    comments: [],
  }, null);
}

// 在卡片上 bind click：開 modal 顯示資料
// 卡片點擊綁定。重要：每次 run()（mode 切換）都會 re-call bindCardClick；
// 早期版本用 dataset.clickBound 避免重綁、結果讓 title/note/articles 卡在第一次 bind 時的值（24h），
// 改成把最新 config 存在 _cardBindings，handler 只綁一次但每次點擊讀最新 config。
const _cardBindings = {};
function bindCardClick(elemId, title, note, getArticlesFn){
  const num = document.getElementById(elemId);
  if (!num) return;
  const card = num.closest('.card');
  if (!card) return;
  _cardBindings[elemId] = { title, note, getArticlesFn };
  if (card.dataset.clickBound === '1') return;
  card.dataset.clickBound = '1';
  card.classList.add('card-clickable');
  card.addEventListener('click', () => {
    const cfg = _cardBindings[elemId];
    if (!cfg) return;
    const articles = cfg.getArticlesFn() || [];
    openArticlesModal(cfg.title, cfg.note, articles);
  });
}

async function openPastEventModal(h, dateStr){
  // Lazy-load 該日完整 archive；不存在就 fallback 到 entry 內嵌的舊格式資料
  let archiveEvents = _pastArchiveCache[dateStr];
  if (archiveEvents === undefined){
    const archive = await fetchJSON(`./hotspot_archive/${dateStr}.json`);
    archiveEvents = (archive && Array.isArray(archive.hotspots)) ? archive.hotspots : null;
    _pastArchiveCache[dateStr] = archiveEvents;
  }
  let news = [];
  let comments = [];
  // 給 modal 的 count：優先用 archive 真實值（backfill 後可能比 index 大）
  let newsCount = h.news_count || 0;
  let commentCount = h.comment_count || 0;
  if (archiveEvents){
    const found = archiveEvents.find(x => x.title === h.title);
    if (found){
      news = found.news_articles || [];
      comments = found.comments || [];
      // 用 archive 的實際數
      if (typeof found.news_count === 'number') newsCount = found.news_count;
      if (typeof found.comment_count === 'number') commentCount = found.comment_count;
    }
  } else {
    // 沒 archive 檔 → 用舊版 index 自帶的資料
    // 舊格式 1（split 之前）：news_articles_top + comments_top
    // 舊格式 2（更早）：sample_titles（只剩標題沒 url）
    if (Array.isArray(h.news_articles_top) && h.news_articles_top.length){
      news = h.news_articles_top;
    } else if (Array.isArray(h.sample_titles) && h.sample_titles.length){
      news = h.sample_titles.map(t => ({ title: t, url: '', time: '' }));
    }
    if (Array.isArray(h.comments_top) && h.comments_top.length){
      comments = h.comments_top;
    }
  }

  const fakeHotspot = {
    title: `[${dateStr}] ${h.title || '事件'}`,
    place: h.place,
    level: h.level,
    source: (news.length ? 'news' : '') + (comments.length ? ((news.length ? ' + ' : '') + 'comment') : ''),
    platform: '',
    note: `${dateStr} 命中 ${newsCount + commentCount} 則（新聞 ${newsCount}、留言 ${commentCount}）`,
    news_count: newsCount,
    comment_count: commentCount,
    news_articles: news,
    comments: comments,
    news_full_expires_at: null,  // 歷史不算壽命
  };
  openHotspotDetailModal(fakeHotspot, null);
}

// --------- Media framing matrix (city × candidate) ---------
function renderMediaFraming(d){
  const wrap = document.getElementById('mediaFramingMatrix');
  const meta = document.getElementById('mediaFramingMeta');
  if (!wrap) return;
  wrap.innerHTML = '';

  const data = d.media_framing_7d;
  if (!data || !Array.isArray(data.cells) || data.cells.length === 0){
    wrap.innerHTML = '<p class="hint">7 日內樣本不足，無法顯示矩陣。</p>';
    if (meta) meta.textContent = '';
    return;
  }

  const CANDIDATES = ['盧秀燕', '蔣萬安', '陳其邁', '蔡其昌'];
  const CITY_ORDER = [
    '台中', '台北', '新北', '桃園', '台南', '高雄',
    '基隆', '新竹市', '嘉義市',
    '新竹縣', '苗栗', '彰化', '南投', '雲林', '嘉義縣',
    '屏東', '宜蘭', '花蓮', '台東',
    '澎湖', '金門', '連江',
  ];

  // Build lookup: cells[(city,cand)] = cell
  const lookup = {};
  data.cells.forEach(c => { lookup[`${c.city}|${c.candidate}`] = c; });

  // Only show cities that have at least one cell
  const citiesWithData = CITY_ORDER.filter(city =>
    CANDIDATES.some(cand => lookup[`${city}|${cand}`])
  );

  // Build table
  const table = document.createElement('table');
  table.className = 'mf-table';
  // Header
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.appendChild(Object.assign(document.createElement('th'), { textContent: '縣市', className: 'mf-col-city' }));
  CANDIDATES.forEach(cand => {
    const th = document.createElement('th');
    th.textContent = cand;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  // Body
  const tbody = document.createElement('tbody');
  citiesWithData.forEach(city => {
    const tr = document.createElement('tr');
    const cityTd = document.createElement('td');
    cityTd.className = 'mf-cell-city';
    cityTd.textContent = city;
    tr.appendChild(cityTd);
    CANDIDATES.forEach(cand => {
      const td = document.createElement('td');
      td.className = 'mf-cell';
      const cell = lookup[`${city}|${cand}`];
      if (!cell){
        td.classList.add('mf-empty');
        td.textContent = '—';
      } else {
        const pct = cell.negativity_pct;
        const tone = pct <= 20 ? 'pos' : pct <= 40 ? 'mid' : pct <= 70 ? 'neg' : 'verybad';
        td.classList.add(`mf-tone-${tone}`);
        td.classList.add('mf-clickable');
        td.innerHTML = `
          <div class="mf-num">${cell.news_count} 篇</div>
          <div class="mf-pct">負面 ${pct}%</div>
        `;
        td.title = `點擊查看 ${city} × ${cand} 相關新聞清單（news_count=${cell.news_count}, negative=${cell.negative_count}, sentiment=${cell.sentiment_score}）`;
        td.addEventListener('click', () => {
          const articles = Array.isArray(cell.articles) ? cell.articles : [];
          const note = `近 7 日全國新聞中，標題同時提到「${city}」與「${cand}」的命中：${cell.news_count} 篇（負面 ${pct}%）`;
          openArticlesModal(`${city} × ${cand} · 媒體 framing 樣本`, note, articles);
        });
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);

  if (meta){
    meta.textContent = `樣本：7 日全國新聞共 ${data.sample_size} 篇 ｜ 顯示門檻：≥ ${data.min_sample} 篇 ｜ 共 ${data.cells.length} 個有效格。`;
  }
}

// --------- Election village chloropleth map ---------
let electionMap;
let electionMapLayer;
const _emGeoCache = {};   // code → GeoJSON
const STRATEGY_COLORS = {
  'A_LOCKED':            '#1d3a72',  // 深藍：鎖定區
  'B_PURE_SWING':        '#ff7b1f',  // 橙：純搖擺主戰場
  'C_FLIPPABLE':         '#f7c948',  // 黃：翻轉潛力
  'D_LOW_TURNOUT':       '#20c997',  // 綠：低投票率動員
  'E_AGEING_SATURATED':  '#777777',  // 灰：飽和
};
const PERSISTENCE_MAP_COLORS = {
  '永藍': '#1d3a72', '永綠': '#1a5031', '永白': '#bbbbbb',
  '翻轉': '#f7c948', '搖擺': '#ff7b1f', '其他': '#444444',
};
// 總統得票/預測的政黨色 — 只用在 presidential_2024 / presidential_predict 兩個模式，
// 比 PERSISTENCE_MAP_COLORS 亮，方便在地圖上一眼辨認。
const PARTY_MAP_COLORS = {
  KMT: '#3b82f6',  // 亮藍（Tailwind blue-500）
  DPP: '#22c55e',  // 亮綠（green-500）
  TPP: '#e5e7eb',  // 亮白（neutral-200，深底也看得見）
  PFP: '#f97316',  // 橘（親民黨）
};
function presidentialColorByYear(v, year){
  const r = (v.presidential_history || []).find(x => x.year === year);
  if (!r) return '#444';
  return PARTY_MAP_COLORS[r.winner] || '#444';
}
function presidentialColorByPrediction(v){
  const pred = v.presidential_prediction;
  if (!pred) return '#444';
  return PARTY_MAP_COLORS[pred.predicted_winner] || '#444';
}
function presidentialColorByPredictionPolls(v){
  const pred = v.presidential_prediction_polls;
  if (!pred) return '#444';
  return PARTY_MAP_COLORS[pred.predicted_winner] || '#444';
}
function priorityToColor(p){
  // 0-100 → 淡藍 → 黃 → 紅
  const x = Math.max(0, Math.min(100, p)) / 100;
  if (x < 0.5){
    // 淡藍 → 黃
    const t = x * 2;
    const r = Math.round(70 + (247-70)*t);
    const g = Math.round(115 + (201-115)*t);
    const b = Math.round(180 + (72-180)*t);
    return `rgb(${r},${g},${b})`;
  } else {
    // 黃 → 紅
    const t = (x - 0.5) * 2;
    const r = Math.round(247 + (255-247)*t);
    const g = Math.round(201 + (77-201)*t);
    const b = Math.round(72 + (79-72)*t);
    return `rgb(${r},${g},${b})`;
  }
}

// --------- Election forecast aggregate (6 都/縣市總票數預測) ---------
async function renderElectionForecast(){
  const container = document.getElementById('forecastBody');
  if (!container) return;
  let data;
  try {
    data = await fetchJSON('./election_priority.json');
  } catch (e) {
    container.innerHTML = '<p class="hint">資料載入失敗。</p>';
    return;
  }
  // 優先顯示全國 22 縣市加總；6 都加總當作備援（缺 country 才用）。
  const country = data.country_aggregate;
  const six = data.six_cities_aggregate;
  const agg = country || six;
  if (!agg || !agg.predicted){
    container.innerHTML = '<p class="hint">沒有預測資料。</p>';
    return;
  }

  const fmt = (n) => n.toLocaleString();
  const pred = agg.predicted;
  const a24 = agg.actual_2024;
  const a20 = agg.actual_2020;
  const isCountry = !!country;
  const scopeLabel = isCountry ? '全國 22 縣市加總' : '6 都加總';
  const totalKey = isCountry ? 'total_estimated_votes' : 'total_estimated_votes';

  // Delta vs 2024 (預測 - 2024 實際) — 看模型認為哪一黨會漲跌
  const deltaKMT = pred.kmt_pct - a24.kmt_pct;
  const deltaDPP = pred.dpp_pct - a24.dpp_pct;
  const deltaTPP = pred.tpp_pct - a24.tpp_pct;
  const fmtDelta = (d) => (d > 0 ? '+' : '') + d.toFixed(1) + 'pt';
  const arrow = (d) => d > 0.1 ? '▲' : d < -0.1 ? '▼' : '＝';

  // 三黨橫條（一條長條，3 段）
  const stackBar = (kmt, dpp, tpp) => `
    <div class="forecast-stack-bar">
      <div class="forecast-seg" style="width:${kmt}%;background:#3b82f6"  title="KMT ${kmt.toFixed(1)}%">${kmt >= 8 ? 'KMT ' + kmt.toFixed(1) + '%' : ''}</div>
      <div class="forecast-seg" style="width:${dpp}%;background:#22c55e"  title="DPP ${dpp.toFixed(1)}%">${dpp >= 8 ? 'DPP ' + dpp.toFixed(1) + '%' : ''}</div>
      <div class="forecast-seg" style="width:${tpp}%;background:#e5e7eb;color:#1a1a1a" title="TPP ${tpp.toFixed(1)}%">${tpp >= 8 ? 'TPP ' + tpp.toFixed(1) + '%' : ''}</div>
    </div>`;

  const partyClass = (p) => p === 'KMT' ? 'persist-blue' : p === 'DPP' ? 'persist-green' : p === 'TPP' ? 'persist-white' : 'persist-other';

  // 全國 / 6 都 totals card
  const villageCount = pred.total_villages || pred.sample_villages || '?';
  const totalCard = `
    <div class="forecast-six-card">
      <div class="forecast-headline">
        <span class="forecast-label">${scopeLabel}預測勝者</span>
        <span class="ep-persist-pill ${partyClass(pred.predicted_winner)}" style="font-size:15px">${pred.predicted_winner}</span>
        <span class="hint">　領先 ${pred.predicted_margin.toFixed(1)} 個百分點　涵蓋 ${villageCount} 里</span>
      </div>
      ${stackBar(pred.kmt_pct, pred.dpp_pct, pred.tpp_pct)}
      <div class="forecast-vote-grid">
        <div><span class="forecast-vote-label">KMT</span><span class="forecast-vote-num">${fmt(pred.kmt_votes)} 票</span></div>
        <div><span class="forecast-vote-label">DPP</span><span class="forecast-vote-num">${fmt(pred.dpp_votes)} 票</span></div>
        <div><span class="forecast-vote-label">TPP</span><span class="forecast-vote-num">${fmt(pred.tpp_votes)} 票</span></div>
        <div><span class="forecast-vote-label">推估投票數</span><span class="forecast-vote-num">${fmt(pred.total_estimated_votes)} 票</span></div>
      </div>

      <div class="forecast-compare">
        <div class="forecast-compare-title">vs 2024 實際得票</div>
        <div class="forecast-compare-row"><span class="forecast-compare-cell">KMT　${a24.kmt_pct.toFixed(1)}%　→　${pred.kmt_pct.toFixed(1)}%　<span class="forecast-delta ${deltaKMT>=0?'pos':'neg'}">${arrow(deltaKMT)} ${fmtDelta(deltaKMT)}</span></span></div>
        <div class="forecast-compare-row"><span class="forecast-compare-cell">DPP　${a24.dpp_pct.toFixed(1)}%　→　${pred.dpp_pct.toFixed(1)}%　<span class="forecast-delta ${deltaDPP>=0?'pos':'neg'}">${arrow(deltaDPP)} ${fmtDelta(deltaDPP)}</span></span></div>
        <div class="forecast-compare-row"><span class="forecast-compare-cell">TPP　${a24.tpp_pct.toFixed(1)}%　→　${pred.tpp_pct.toFixed(1)}%　<span class="forecast-delta ${deltaTPP>=0?'pos':'neg'}">${arrow(deltaTPP)} ${fmtDelta(deltaTPP)}</span></span></div>
      </div>
      <p class="hint" style="margin-top:8px">
        2020 對照：KMT ${a20 ? a20.kmt_pct.toFixed(1) : '—'}% / DPP ${a20 ? a20.dpp_pct.toFixed(1) : '—'}%
        ｜${agg.note || ''}
      </p>
    </div>`;

  // Per-city breakdown
  const cityRows = (agg.by_city || []).map(c => {
    const w = c.winner;
    const confLabel = { high: '高', medium: '中', low: '低' }[c.confidence] || c.confidence;
    return `
      <div class="forecast-city-row">
        <div class="forecast-city-name">${c.name}</div>
        <div class="forecast-city-bar">${stackBar(c.kmt_pct, c.dpp_pct, c.tpp_pct)}</div>
        <div class="forecast-city-meta">
          <span class="ep-persist-pill ${partyClass(w)}">${w}</span>
          <span class="hint">領先 ${c.margin.toFixed(1)}pt　信心 ${confLabel}</span>
        </div>
      </div>`;
  }).join('');

  // 民調校正版本
  const polls = agg.predicted_with_polls;
  const pollsMeta = agg.polls_meta;
  let pollsCard = '';
  if (polls && pollsMeta){
    const swing = pollsMeta.swing || {};
    const dKMT = polls.kmt_pct - pred.kmt_pct;
    const dDPP = polls.dpp_pct - pred.dpp_pct;
    const dTPP = polls.tpp_pct - pred.tpp_pct;
    const sourceLine = (pollsMeta.sources || []).map(s =>
      `${s.pollster}（${s.date}${s.n ? '，n=' + s.n : ''}）`
    ).join('、') || '（未填入民調來源）';

    // Staleness: 民調超過 30 天視為過期（顯示橘色警告）
    let staleness = '';
    const asOfStr = pollsMeta.as_of;
    if (asOfStr){
      const asOfTime = new Date(asOfStr).getTime();
      const ageDays = Math.max(0, Math.floor((Date.now() - asOfTime) / 86400000));
      if (ageDays > 60){
        staleness = `<span style="color:#ef4444">⚠️ 民調已 ${ageDays} 天未更新（建議 ≤30 天）— 跑 scripts/fetch_polls.py 自動刷新</span>`;
      } else if (ageDays > 30){
        staleness = `<span style="color:#f59e0b">⚠️ 民調已 ${ageDays} 天未更新</span>`;
      } else {
        staleness = `<span style="color:#22c55e">✓ 民調 ${ageDays === 0 ? '今天' : ageDays + ' 天前'}更新</span>`;
      }
    }

    pollsCard = `
      <div class="forecast-six-card forecast-polls-card">
        <div class="forecast-headline">
          <span class="forecast-label">民調校正後預測勝者</span>
          <span class="ep-persist-pill ${partyClass(polls.predicted_winner)}" style="font-size:15px">${polls.predicted_winner}</span>
          <span class="hint">　領先 ${polls.predicted_margin.toFixed(1)} 個百分點　民調日期 ${pollsMeta.as_of || '—'}　${staleness}</span>
        </div>
        ${stackBar(polls.kmt_pct, polls.dpp_pct, polls.tpp_pct)}
        <div class="forecast-vote-grid">
          <div><span class="forecast-vote-label">KMT</span><span class="forecast-vote-num">${fmt(polls.kmt_votes)} 票</span></div>
          <div><span class="forecast-vote-label">DPP</span><span class="forecast-vote-num">${fmt(polls.dpp_votes)} 票</span></div>
          <div><span class="forecast-vote-label">TPP</span><span class="forecast-vote-num">${fmt(polls.tpp_votes)} 票</span></div>
          <div><span class="forecast-vote-label">推估投票數</span><span class="forecast-vote-num">${fmt(polls.total_estimated_votes)} 票</span></div>
        </div>
        <div class="forecast-compare">
          <div class="forecast-compare-title">vs 純基本面預測（民調 swing 套用後）</div>
          <div class="forecast-compare-row"><span class="forecast-compare-cell">KMT　${pred.kmt_pct.toFixed(1)}%　→　${polls.kmt_pct.toFixed(1)}%　<span class="forecast-delta ${dKMT>=0?'pos':'neg'}">${arrow(dKMT)} ${fmtDelta(dKMT)}</span>　（民調 swing ${swing.KMT >= 0 ? '+' : ''}${swing.KMT}pt）</span></div>
          <div class="forecast-compare-row"><span class="forecast-compare-cell">DPP　${pred.dpp_pct.toFixed(1)}%　→　${polls.dpp_pct.toFixed(1)}%　<span class="forecast-delta ${dDPP>=0?'pos':'neg'}">${arrow(dDPP)} ${fmtDelta(dDPP)}</span>　（民調 swing ${swing.DPP >= 0 ? '+' : ''}${swing.DPP}pt）</span></div>
          <div class="forecast-compare-row"><span class="forecast-compare-cell">TPP　${pred.tpp_pct.toFixed(1)}%　→　${polls.tpp_pct.toFixed(1)}%　<span class="forecast-delta ${dTPP>=0?'pos':'neg'}">${arrow(dTPP)} ${fmtDelta(dTPP)}</span>　（民調 swing ${swing.TPP >= 0 ? '+' : ''}${swing.TPP}pt）</span></div>
        </div>
        <p class="hint" style="margin-top:8px">
          <strong>民調來源</strong>：${sourceLine}<br>
          <strong>方法</strong>：「政黨支持度 - 2024 實際得票」算 swing，每個里加上同一個 swing 後再正規化（uniform swing）。
          <strong>限制</strong>：(1) uniform swing 假設全國均勻偏移，沒抓地域差異；
          (2) 政黨支持度 ≠ 投票意向；(3) 民調抽樣誤差 ±3%；(4) 2028 候選人未定。
          編輯 <code>dashboard/polls_config.json</code> 更新民調數字後，下次 build 會生效。
        </p>
      </div>`;
  }

  container.innerHTML = `
    ${totalCard}
    ${pollsCard}
    <h3 style="margin-top:18px;color:#d8e2ff;font-size:14px">${isCountry ? '各縣市預測明細（22 個）' : '各都預測明細'}</h3>
    <div class="forecast-city-list">${cityRows}</div>
    <p class="hint" style="margin-top:12px">
      <strong>模型方法</strong>：每個里計算下屆總統選舉預測（加權近 5 屆得票 + momentum 趨勢延伸 ×0.3），
      再以該里 2024 投票數作權重加總到縣市 / 6 都。${polls ? '另出一份「民調校正後」版本：對基本面預測套上 uniform swing。' : ''}<br>
      <strong>模型局限</strong>：${polls ? '即便有民調 swing，仍' : '純基本面，'}沒考慮現任效應、新政黨崛起、候選人組合差異、突發事件。<br>
      <strong>backtest（用 2008-2020 預測 2024）</strong>：村里級勝者準確率 85.5%，
      但 TPP 系統性低估 26pt（無法預測新政黨）、DPP 高估 20pt（過度延伸近期趨勢）。
      <em>當作參考，不要當真值用</em>。
    </p>
  `;
}

async function renderElectionMap(){
  const container = document.getElementById('electionMap');
  if (!container || typeof window.L === 'undefined') return;

  const citySelect = document.getElementById('emCitySelect');
  const modeSelect = document.getElementById('emModeSelect');
  const status = document.getElementById('emStatus');
  const legendEl = document.getElementById('emLegend');

  const TW_CENTERS = {
    tpe: [25.05, 121.55], ntpc: [24.99, 121.55], tyc: [24.99, 121.30],
    txg: [24.16, 120.65], tnn: [22.99, 120.21], khh: [22.62, 120.31],
    kee: [25.13, 121.74], hsz: [24.81, 120.97], cyi: [23.48, 120.45],
    hsq: [24.70, 121.10], mil: [24.49, 120.92], cha: [24.05, 120.51],
    nan: [23.91, 120.96], yun: [23.71, 120.43], cyq: [23.45, 120.35],
    pif: [22.55, 120.62], ila: [24.70, 121.74], hua: [23.83, 121.40],
    ttt: [22.81, 121.10], peh: [23.57, 119.58],
    kin: [24.43, 118.31], lja: [26.16, 119.95],
  };
  const SIX_CITIES = new Set(['tpe', 'ntpc', 'tyc', 'txg', 'tnn', 'khh']);

  if (!electionMap){
    electionMap = L.map('electionMap', { scrollWheelZoom: false }).setView([23.7, 121], 7);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
                { maxZoom: 18, attribution: '&copy; OpenStreetMap' }).addTo(electionMap);
  }

  const renderLayer = async () => {
    const code = citySelect.value;
    const mode = modeSelect.value;

    if (status) status.textContent = '載入中…';

    let activeMode = mode;

    // Lazy fetch geo + city data
    if (!_emGeoCache[code]){
      const geo = await fetchJSON(`./election_priority/geo/${code}.geo.json`);
      _emGeoCache[code] = geo;
    }
    // 22 縣市現在都有 election_priority/{code}.json（完整 priority/strategy/總統 預測都齊）
    const cityData = await loadEpCity(code);
    if (!cityData || !_emGeoCache[code]){
      if (status) status.textContent = '載入失敗。';
      return;
    }

    // Lookup by (town, village). GeoJSON 來源 plotdb/pdmaptw 已用 2010 升格後新名，
    // 直接和 priority 資料對齊。
    const lookup = {};
    cityData.villages.forEach(v => {
      lookup[`${v.town}|${v.village}`] = v;
    });
    const lookupVillage = (town, village) => lookup[`${town}|${village}`];

    if (electionMapLayer){
      electionMap.removeLayer(electionMapLayer);
    }

    const styleFn = (feat) => {
      const p = feat.properties || {};
      const v = lookupVillage(p.TOWNNAME, p.VILLAGENAM);
      let color = '#333';
      if (v){
        if (activeMode === 'priority') color = priorityToColor(v.priority);
        else if (activeMode === 'strategy') color = STRATEGY_COLORS[v.strategy_type] || '#444';
        else if (activeMode === 'persistence') color = PERSISTENCE_MAP_COLORS[v.persistence] || '#444';
        else if (activeMode === 'presidential_2024') color = presidentialColorByYear(v, 2024);
        else if (activeMode === 'presidential_predict') color = presidentialColorByPrediction(v);
        else if (activeMode === 'presidential_predict_polls') color = presidentialColorByPredictionPolls(v);
      }
      return {
        color: '#0a0e1a', weight: 0.4,
        fillColor: color, fillOpacity: v ? 0.75 : 0.25,
      };
    };

    electionMapLayer = L.geoJSON(_emGeoCache[code], {
      style: styleFn,
      onEachFeature: (feat, layer) => {
        const p = feat.properties || {};
        const v = lookupVillage(p.TOWNNAME, p.VILLAGENAM);
        let tooltipHtml;
        if (!v){
          tooltipHtml = `<strong>${p.TOWNNAME} ${p.VILLAGENAM}</strong><br>（無資料）`;
        } else if (activeMode === 'presidential_2024'){
          const r = (v.presidential_history || []).find(x => x.year === 2024);
          tooltipHtml = r
            ? `<strong>${p.TOWNNAME} ${p.VILLAGENAM}</strong><br>2024 勝者：<strong>${r.winner}</strong><br>
               KMT ${r.kmt_pct}%　DPP ${r.dpp_pct}%　TPP ${r.tpp_pct}%`
            : `<strong>${p.TOWNNAME} ${p.VILLAGENAM}</strong><br>（總統選舉資料缺）`;
        } else if (activeMode === 'presidential_predict'){
          const pred = v.presidential_prediction;
          tooltipHtml = pred
            ? `<strong>${p.TOWNNAME} ${p.VILLAGENAM}</strong><br>
               預測勝者：<strong>${pred.predicted_winner}</strong>（領先 ${pred.predicted_margin}pt，信心 ${pred.confidence}）<br>
               KMT ${pred.kmt_pct}%　DPP ${pred.dpp_pct}%　TPP ${pred.tpp_pct}%`
            : `<strong>${p.TOWNNAME} ${p.VILLAGENAM}</strong><br>（預測資料缺）`;
        } else if (activeMode === 'presidential_predict_polls'){
          const pred = v.presidential_prediction_polls;
          tooltipHtml = pred
            ? `<strong>${p.TOWNNAME} ${p.VILLAGENAM}</strong><br>
               民調校正預測：<strong>${pred.predicted_winner}</strong>（領先 ${pred.predicted_margin}pt，信心 ${pred.confidence}）<br>
               KMT ${pred.kmt_pct}%　DPP ${pred.dpp_pct}%　TPP ${pred.tpp_pct}%`
            : `<strong>${p.TOWNNAME} ${p.VILLAGENAM}</strong><br>（民調校正預測缺）`;
        } else {
          tooltipHtml = `<strong>${p.TOWNNAME} ${p.VILLAGENAM}</strong><br>
             priority: <strong>${v.priority}</strong><br>
             ${v.strategy_label}<br>
             ${v.persistence}　搖擺度 ${v.volatility}<br>
             人口 ${v.pop.toLocaleString()}　投票率 ${v.turnout != null ? v.turnout + '%' : '—'}`;
        }
        layer.bindTooltip(tooltipHtml, { sticky: true, direction: 'top' });
        layer.on('click', () => {
          if (!v) return;
          openVillageDetail({ ...v, city: code, cityName: cityData.name, source: cityData.source });
        });
        layer.on('mouseover', e => e.target.setStyle({ weight: 2, color: '#5a79ff' }));
        layer.on('mouseout',  e => e.target.setStyle({ weight: 0.4, color: '#0a0e1a' }));
      },
    }).addTo(electionMap);

    // Pan / zoom to city
    const bounds = electionMapLayer.getBounds();
    if (bounds.isValid()) electionMap.fitBounds(bounds, { padding: [10, 10] });

    // Render legend
    if (legendEl){
      let html = '';
      if (activeMode === 'priority'){
        html = `<div class="em-legend-title">Priority 分數（高 = 主戰場）</div>
          <div class="em-legend-gradient"></div>
          <div class="em-legend-scale"><span>0（鎖定）</span><span>50</span><span>100（必爭）</span></div>`;
      } else if (activeMode === 'strategy'){
        html = `<div class="em-legend-title">策略類型</div>
          ${Object.entries(STRATEGY_COLORS).map(([k, c]) => {
            const labels = {A_LOCKED:'A 永○鎖定區', B_PURE_SWING:'B 純搖擺主戰場',
                            C_FLIPPABLE:'C 翻轉潛力', D_LOW_TURNOUT:'D 低投票率動員',
                            E_AGEING_SATURATED:'E 高齡飽和'};
            return `<span class="em-legend-item"><span class="em-legend-swatch" style="background:${c}"></span>${labels[k]}</span>`;
          }).join('')}`;
      } else if (activeMode === 'presidential_2024'){
        html = `<div class="em-legend-title">2024 總統得票（實際勝者）</div>
          ${Object.entries(PARTY_MAP_COLORS).filter(([k]) => ['KMT','DPP','TPP'].includes(k)).map(([k, c]) =>
            `<span class="em-legend-item"><span class="em-legend-swatch" style="background:${c}"></span>${k}</span>`
          ).join('')}`;
      } else if (activeMode === 'presidential_predict'){
        html = `<div class="em-legend-title">下屆總統預測勝者（純基本面）</div>
          ${Object.entries(PARTY_MAP_COLORS).filter(([k]) => ['KMT','DPP','TPP'].includes(k)).map(([k, c]) =>
            `<span class="em-legend-item"><span class="em-legend-swatch" style="background:${c}"></span>${k}</span>`
          ).join('')}
          <div class="hint" style="margin-top:6px;font-size:11px">模型：加權近 5 屆得票（最近權重 0.55、上一屆 0.30）+ momentum 趨勢延伸 ×0.3。沒考慮民調與全國風向，只看歷史基本盤。</div>`;
      } else if (activeMode === 'presidential_predict_polls'){
        html = `<div class="em-legend-title">下屆總統預測勝者（民調校正後）</div>
          ${Object.entries(PARTY_MAP_COLORS).filter(([k]) => ['KMT','DPP','TPP'].includes(k)).map(([k, c]) =>
            `<span class="em-legend-item"><span class="em-legend-swatch" style="background:${c}"></span>${k}</span>`
          ).join('')}
          <div class="hint" style="margin-top:6px;font-size:11px">純基本面預測 + 全國 uniform swing（每個里都加上「民調 - 2024 實際」的差）。民調來源 / 數字編輯 dashboard/polls_config.json。</div>`;
      } else {
        html = `<div class="em-legend-title">政治屬性</div>
          ${Object.entries(PERSISTENCE_MAP_COLORS).map(([k, c]) =>
            `<span class="em-legend-item"><span class="em-legend-swatch" style="background:${c}"></span>${k}</span>`
          ).join('')}`;
      }
      // 16 縣市用「縣市長」作為 priority 基礎，6 都用「直轄市長」
      if (cityData.source === 'local_mayor'){
        html += `<div class="hint" style="margin-top:6px;font-size:11px;color:#94a3b8">ℹ️ 此縣市的 priority/策略/政治屬性 是基於 5 屆縣市長選舉（2005-2022）計算。獨立候選人（IND）在花蓮/臺東/金門等地常獲勝，會反映在 winner 與 volatility 上。</div>`;
      } else if (cityData.source === 'presidential'){
        html += `<div class="hint" style="margin-top:6px;font-size:11px;color:#94a3b8">ℹ️ 此縣市的 priority/策略/政治屬性 是基於 5 屆總統選舉（2008-2024）計算（fallback 來源）。</div>`;
      }
      legendEl.innerHTML = html;
    }

    if (status) status.textContent = `${cityData.name} ${cityData.village_count} 里 · 顏色：${modeSelect.options[modeSelect.selectedIndex].text}`;
  };

  citySelect?.addEventListener('change', renderLayer);
  modeSelect?.addEventListener('change', renderLayer);
  await renderLayer();
}

// --------- Election priority map (黃金戰場版圖) ---------
const _epIndexCache = { data: null };
const _epCityCache = {};  // code → full city data
const PERSISTENCE_COLORS = {
  '永藍': 'persist-blue',
  '永綠': 'persist-green',
  '永白': 'persist-white',
  '翻轉': 'persist-flip',
  '搖擺': 'persist-swing',
  '其他': 'persist-other',
};
// 動作（行動類別）對應的友善 label。第一個欄位是色塊文字，title 提供 hover 補充。
const ACTION_LABELS = {
  GOTV:       { short: 'GOTV · 催票',     full: 'GOTV（Get Out The Vote）｜把已支持的選民帶到投票所。手段：簡訊提醒、人工電話、志工挨家催票、長者接送。' },
  persuasion: { short: 'persuasion · 說服', full: 'persuasion｜針對中間/未表態選民改變投票意向。手段：客製化議題傳單、家戶深度對談、KOL 背書、政策廣告。' },
  mixed:      { short: 'mixed · 雙軌',     full: 'mixed｜對基本盤打 GOTV、對搖擺者打 persuasion，兩線並進。' },
  maintain:   { short: 'maintain · 維護',  full: 'maintain｜不投放新資源，靠樁腳/節慶/宗親會維繫關係，不犯錯比拉票更重要。' },
  skip:       { short: 'skip · 略過',      full: 'skip｜資源效益太低，不主動投放。' },
};
function actionLabel(action){
  return ACTION_LABELS[action] || { short: action || '—', full: '' };
}

async function loadEpIndex(){
  if (_epIndexCache.data) return _epIndexCache.data;
  const d = await fetchJSON('./election_priority.json');
  _epIndexCache.data = d;
  return d;
}

async function loadEpCity(code){
  if (_epCityCache[code]) return _epCityCache[code];
  const d = await fetchJSON(`./election_priority/${code}.json`);
  if (d) _epCityCache[code] = d;
  return d;
}


async function renderElectionPriority(){
  const wrap = document.getElementById('epTableWrap');
  const stats = document.getElementById('epCityStats');
  const status = document.getElementById('epStatus');
  if (!wrap) return;

  const idx = await loadEpIndex();
  if (!idx){
    wrap.innerHTML = '<p class="hint">尚未產生選舉版圖資料。</p>';
    return;
  }

  const citySelect = document.getElementById('epCitySelect');
  const limitSelect = document.getElementById('epLimitSelect');

  const renderTable = async () => {
    const cityCode = citySelect.value;
    const limit = parseInt(limitSelect.value, 10) || 100;
    if (status) status.textContent = '載入中…';

    let villages = [];
    if (cityCode === 'all'){
      // Top N across all cities — 從 index 拿 top_villages 合併
      idx.cities.forEach(c => {
        c.top_villages.forEach(v => villages.push({ ...v, city: c.code, cityName: c.name }));
      });
      villages.sort((a, b) => b.priority - a.priority);
    } else {
      const cityData = await loadEpCity(cityCode);
      if (!cityData){
        wrap.innerHTML = '<p class="hint">找不到該縣市資料。</p>';
        return;
      }
      villages = cityData.villages.map(v => ({ ...v, city: cityCode, cityName: cityData.name }));
    }
    const display = villages.slice(0, limit);

    if (status) status.textContent = `顯示前 ${display.length} 名（總共 ${cityCode === 'all' ? idx.cities.reduce((s,c)=>s+c.village_count, 0) : villages.length} 里）`;

    // Render city stats
    if (stats){
      stats.innerHTML = '';
      idx.cities.forEach(c => {
        if (cityCode !== 'all' && c.code !== cityCode) return;
        const counts = c.persistence_counts || {};
        const item = document.createElement('div');
        item.className = 'ep-city-stat';
        item.innerHTML = `
          <strong>${escapeHtml(c.name)}</strong>（${c.village_count} 里）
          <span class="ep-persist-pill persist-blue">永藍 ${counts['永藍']||0}</span>
          <span class="ep-persist-pill persist-green">永綠 ${counts['永綠']||0}</span>
          <span class="ep-persist-pill persist-flip">翻轉 ${counts['翻轉']||0}</span>
          <span class="ep-persist-pill persist-swing">搖擺 ${counts['搖擺']||0}</span>
        `;
        stats.appendChild(item);
      });
    }

    // Build table
    wrap.innerHTML = '';
    if (!display.length){
      wrap.innerHTML = '<p class="hint">目前沒有資料。</p>';
      return;
    }
    const table = document.createElement('table');
    table.className = 'ep-table';
    table.innerHTML = `
      <thead><tr>
        <th>排名</th>
        <th>縣市</th>
        <th>區 / 里</th>
        <th>人口</th>
        <th>屬性</th>
        <th>策略</th>
        <th title="GOTV=催票（已支持者）｜persuasion=說服（中間選民）｜mixed=雙軌｜maintain=維護">行動方式</th>
        <th>預算</th>
        <th>投票率</th>
        <th>搖擺度</th>
        <th>Priority</th>
      </tr></thead>`;
    const tbody = document.createElement('tbody');
    display.forEach((v, i) => {
      const tr = document.createElement('tr');
      tr.className = 'ep-row';
      const persistCls = PERSISTENCE_COLORS[v.persistence] || 'persist-other';
      const stratCls = `strategy-${(v.strategy_type || '').toLowerCase().replace('_', '-')}`;
      const actionCls = `action-${(v.action || '').toLowerCase()}`;
      const budgetCls = `budget-${(v.budget_hint || '').toLowerCase()}`;
      tr.innerHTML = `
        <td class="ep-rank">${i + 1}</td>
        <td class="ep-city">${escapeHtml(v.cityName)}</td>
        <td class="ep-village"><strong>${escapeHtml(v.town)}</strong> ${escapeHtml(v.village)}</td>
        <td class="ep-num">${v.pop.toLocaleString()}</td>
        <td><span class="ep-persist-pill ${persistCls}">${escapeHtml(v.persistence)}</span></td>
        <td><span class="ep-strategy-pill ${stratCls}" title="${escapeHtml((v.outreach || []).join('、'))}">${escapeHtml(v.strategy_label || '—')}</span></td>
        <td><span class="ep-action-pill ${actionCls}" title="${escapeHtml(actionLabel(v.action).full)}">${escapeHtml(actionLabel(v.action).short)}</span></td>
        <td><span class="ep-budget-pill ${budgetCls}">${escapeHtml(v.budget_hint || '—')}</span></td>
        <td class="ep-num">${v.turnout != null ? v.turnout + '%' : '—'}</td>
        <td class="ep-num">${v.volatility}</td>
        <td class="ep-priority"><strong>${v.priority}</strong></td>
      `;
      tr.addEventListener('click', () => openVillageDetail(v));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
  };

  citySelect?.addEventListener('change', renderTable);
  limitSelect?.addEventListener('change', renderTable);
  await renderTable();
}

function renderPresidentialBlock(v){
  const hist = v.presidential_history || [];
  const pred = v.presidential_prediction;
  if (!hist.length) return '';

  const partyClass = (p) => p === 'KMT' ? 'persist-blue' : p === 'DPP' ? 'persist-green'
                          : p === 'TPP' ? 'persist-white' : p === 'PFP' ? 'persist-flip' : 'persist-other';

  const histRows = hist.map(r => `
    <tr>
      <td>${r.year}</td>
      <td><span class="ep-persist-pill ${partyClass(r.winner)}">${r.winner || '—'}</span></td>
      <td class="ep-num">${r.kmt_pct}%</td>
      <td class="ep-num">${r.dpp_pct}%</td>
      <td class="ep-num">${r.tpp_pct > 0 ? r.tpp_pct + '%' : '—'}</td>
      <td class="ep-num">${r.pfp_pct > 0 ? r.pfp_pct + '%' : '—'}</td>
      <td class="ep-num">${r.total.toLocaleString()}</td>
    </tr>`).join('');

  const renderPredCard = (p, label, extraNote='') => {
    if (!p) return '';
    const cls = partyClass(p.predicted_winner);
    const confLabel = { high: '高（差距 ≥15pt）',
                        medium: '中（差距 5-15pt）',
                        low: '低（差距 <5pt 膠著）' }[p.confidence] || p.confidence;
    return `
      <div class="ep-prediction-box ${label === '民調校正後' ? 'ep-prediction-polls' : ''}">
        <div class="ep-prediction-headline">
          🔮 ${label}：
          <span class="ep-persist-pill ${cls}" style="font-size:14px">${p.predicted_winner}</span>
          <span class="hint">　領先 ${p.predicted_margin}pt　信心 ${confLabel}</span>
        </div>
        <div class="ep-prediction-bars">
          <div class="ep-bar-row"><span class="ep-bar-label">KMT</span>
            <div class="ep-bar"><div class="ep-bar-fill" style="width:${p.kmt_pct}%;background:#3b82f6"></div></div>
            <span class="ep-bar-pct">${p.kmt_pct}%</span></div>
          <div class="ep-bar-row"><span class="ep-bar-label">DPP</span>
            <div class="ep-bar"><div class="ep-bar-fill" style="width:${p.dpp_pct}%;background:#22c55e"></div></div>
            <span class="ep-bar-pct">${p.dpp_pct}%</span></div>
          <div class="ep-bar-row"><span class="ep-bar-label">TPP</span>
            <div class="ep-bar"><div class="ep-bar-fill" style="width:${p.tpp_pct}%;background:#e5e7eb"></div></div>
            <span class="ep-bar-pct">${p.tpp_pct}%</span></div>
        </div>
        ${extraNote ? `<div class="hint" style="margin-top:8px">${extraNote}</div>` : ''}
      </div>`;
  };

  const predBaselineNote = '模型：加權近 5 屆得票（最近 0.55、上一屆 0.30、再上一屆 0.10）+ momentum（最近 2 屆 vs 之前的趨勢延伸 ×0.3）。沒考慮民調 — 純歷史基本盤。';
  const predBaseline = renderPredCard(pred, '下屆總統預測（純基本面）', predBaselineNote);

  const predPolls = v.presidential_prediction_polls;
  let predPollsBlock = '';
  if (predPolls && pred){
    const swing = predPolls.swing_applied || {};
    const note = `對純基本面套上全國 uniform swing：KMT ${swing.KMT >= 0 ? '+' : ''}${swing.KMT}pt、DPP ${swing.DPP >= 0 ? '+' : ''}${swing.DPP}pt、TPP ${swing.TPP >= 0 ? '+' : ''}${swing.TPP}pt（民調 - 2024 實際）後再正規化。`;
    predPollsBlock = renderPredCard(predPolls, '民調校正後', note);
  }
  const predBlock = predBaseline + predPollsBlock;

  return `
    <h3>🗳️ 歷年總統選舉（${hist[0].year}–${hist[hist.length-1].year}，全 ${hist.length} 屆）</h3>
    <table class="ep-history-table">
      <thead><tr>
        <th>年</th><th>勝者</th><th>KMT</th><th>DPP</th><th>TPP</th><th>PFP</th><th>總票數</th>
      </tr></thead>
      <tbody>${histRows}</tbody>
    </table>
    ${predBlock}
  `;
}

// 把里級地圖聚焦到指定里，加上閃爍高亮 + 開 tooltip
function focusVillageOnMap({ city, town, village }){
  if (!city || !town || !village) return;
  const emCity = document.getElementById('emCitySelect');
  if (!emCity) return;
  const needsCityChange = emCity.value !== city;
  if (needsCityChange){
    emCity.value = city;
    emCity.dispatchEvent(new Event('change'));
  }

  const tryFocus = (attempts = 0) => {
    if (!electionMapLayer || electionMapLayer.getLayers().length < 2){
      if (attempts < 30) return setTimeout(() => tryFocus(attempts + 1), 250);
      console.warn('focusVillageOnMap: layer not loaded');
      return;
    }
    let found = null;
    electionMapLayer.eachLayer(layer => {
      const p = (layer.feature && layer.feature.properties) || {};
      if (p.TOWNNAME === town && p.VILLAGENAM === village){
        found = layer;
      }
    });
    // 找不到時試正規化（plotdb 偶有 鎮/鄉/市 vs 區、村 vs 里 的差）
    if (!found){
      electionMapLayer.eachLayer(layer => {
        const p = (layer.feature && layer.feature.properties) || {};
        const normTown = (p.TOWNNAME || '').replace(/[鎮鄉市]$/, '區');
        const normVil  = (p.VILLAGENAM || '').replace(/村$/, '里');
        if ((normTown === town || p.TOWNNAME === town) &&
            (normVil === village || p.VILLAGENAM === village)){
          found = layer;
        }
      });
    }
    if (!found){
      console.warn(`focusVillageOnMap: ${town}|${village} 找不到對應 polygon`);
      return;
    }
    // pan/zoom + 閃爍高亮
    const bounds = found.getBounds();
    if (bounds && bounds.isValid()){
      electionMap.fitBounds(bounds, { maxZoom: 15, padding: [80, 80] });
    }
    // 高亮 — 黃色粗邊 3 秒後恢復
    const origStyle = { weight: 0.4, color: '#0a0e1a' };
    found.setStyle({ weight: 5, color: '#fbbf24' });
    setTimeout(() => { try { found.setStyle(origStyle); } catch(e){} }, 3000);
    if (found.getTooltip()) found.openTooltip();
    document.getElementById('electionMapPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  setTimeout(tryFocus, needsCityChange ? 200 : 0);
}

// 全域 click handler 處理 .ep-maps-btn — 用 event delegation 因為按鈕在動態 modal 裡
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.ep-maps-btn');
  if (!btn) return;
  const payload = btn.getAttribute('data-focus');
  if (!payload) return;
  try {
    const v = JSON.parse(payload);
    focusVillageOnMap(v);
    // 關閉 modal
    const modal = document.getElementById('hotspotDetailModal');
    if (modal){
      modal.classList.add('hidden');
      document.body.style.overflow = '';
    }
  } catch(err){
    console.warn('focus btn payload parse failed:', err);
  }
});

function openVillageDetail(v){
  // 重用既有 hotspotDetailModal — 把里資訊塞進去顯示
  const years = v.years || [];
  const histRows = years.map((y, i) => {
    const kmt = v.kmt_rates?.[i] ?? 0;
    const dpp = v.dpp_rates?.[i] ?? 0;
    const tpp = v.tpp_rates?.[i] ?? 0;
    const winner = v.winner_parties?.[i] || '';
    const winnerCls = winner === 'KMT' ? 'persist-blue' : winner === 'DPP' ? 'persist-green' : winner === 'TPP' ? 'persist-white' : 'persist-other';
    return `
      <tr>
        <td>${y}</td>
        <td><span class="ep-persist-pill ${winnerCls}">${winner || '—'}</span></td>
        <td class="ep-num">${kmt}%</td>
        <td class="ep-num">${dpp}%</td>
        <td class="ep-num">${tpp}%</td>
      </tr>`;
  }).join('');

  const stratCls = `strategy-${(v.strategy_type || '').toLowerCase().replace('_', '-')}`;
  const actionCls = `action-${(v.action || '').toLowerCase()}`;
  const budgetCls = `budget-${(v.budget_hint || '').toLowerCase()}`;
  const dp = v.demo_profile || {};
  const ageMap = { young: '青年化', mid: '中壯年', senior: '高齡化', mixed: '混合' };
  const eduMap = { high: '高教育', mid: '中等教育', low: '基礎教育' };
  const genderMap = { male: '男性偏多', female: '女性偏多', balanced: '性別均衡' };

  // 「在里級地圖上查看」— 切到該縣市的 Leaflet 地圖、聚焦該里、高亮並開 tooltip
  const focusBtnPayload = JSON.stringify({ city: v.city, town: v.town, village: v.village });

  const html = `
    <div class="ep-detail-meta">
      <div class="ep-detail-meta-headline">
        <strong style="font-size:15px">${escapeHtml(v.cityName || '')} ${escapeHtml(v.town || '')} ${escapeHtml(v.village || '')}</strong>
        <span class="ep-priority-tag">priority ${v.priority}</span>
        <button class="ep-maps-btn" type="button" data-focus='${escapeHtml(focusBtnPayload)}' title="在上方「里級地理視覺化」地圖上聚焦此里">📍 在地圖上聚焦</button>
      </div>
      <div class="hint">人口 ${v.pop.toLocaleString()}（合格選舉人 ${v.voters.toLocaleString()}）　投票率 ${v.turnout != null ? v.turnout + '%' : '—'}　中位年齡 ${v.median_age || '—'} 歲</div>
      <div class="hint">屬性：<span class="ep-persist-pill ${PERSISTENCE_COLORS[v.persistence] || 'persist-other'}">${escapeHtml(v.persistence)}</span>　搖擺度 ${v.volatility}　翻盤 ${v.flips} 次　最近差距 ${v.latest_margin}%　說服空間 ${v.persuadability}</div>
    </div>

    <h3>🎯 拉票策略建議（給幕僚操作用）</h3>
    <div class="ep-strategy-box">
      <div class="ep-strategy-headline">
        <span class="ep-strategy-pill ${stratCls}">${escapeHtml(v.strategy_label || '—')}</span>
        <span class="ep-action-pill ${actionCls}" title="${escapeHtml(actionLabel(v.action).full)}">${escapeHtml(actionLabel(v.action).short)}</span>
        <span class="ep-budget-pill ${budgetCls}">預算：${escapeHtml(v.budget_hint || '—')}</span>
      </div>
      ${actionLabel(v.action).full ? `<p class="ep-action-explainer">${escapeHtml(actionLabel(v.action).full)}</p>` : ''}
      ${v.strategy_reason ? `<p class="ep-strategy-reason">${escapeHtml(v.strategy_reason)}</p>` : ''}

      <div class="ep-detail-list-title">建議接觸方式（${(v.outreach || []).length} 種）</div>
      <ul class="ep-detail-list">
        ${(v.outreach || []).map(o => `
          <li>
            <span class="ep-list-name">${escapeHtml(o)}</span>
            <span class="ep-list-reason">${escapeHtml((_epIndexCache.data?.reasons?.outreach || {})[o] || '')}</span>
          </li>`).join('')}
      </ul>

      <div class="ep-detail-list-title">議題優先序（${(v.topics || []).length} 個）</div>
      <ul class="ep-detail-list">
        ${(v.topics || []).map((t, i) => `
          <li>
            <span class="ep-list-num">${i + 1}.</span>
            <span class="ep-list-name">${escapeHtml(t)}</span>
            <span class="ep-list-reason">${escapeHtml((_epIndexCache.data?.reasons?.topics || {})[t] || '')}</span>
          </li>`).join('')}
      </ul>
    </div>

    <h3>👥 人口圖像</h3>
    <div class="ep-demo-box">
      <div class="ep-demo-row">
        <span class="ep-demo-tag">${escapeHtml(ageMap[dp.age_skew] || dp.age_skew || '—')}</span>
        <span class="ep-demo-tag">${escapeHtml(eduMap[dp.edu_skew] || dp.edu_skew || '—')}</span>
        <span class="ep-demo-tag">${escapeHtml(genderMap[dp.gender_skew] || dp.gender_skew || '—')}</span>
      </div>
      <div class="hint">20-39 歲 ${v.a20_39_pct}%　60+ 歲 ${v.a60up_pct}%　大專以上 ${v.high_edu_pct}%（含研究所 ${v.graduate_pct}%）　男性比例 ${v.male_pct}%</div>
    </div>

    ${v.source === 'presidential' ? '' : `
    <h3>📜 ${v.source === 'local_mayor' ? '歷次縣市長選舉' : '歷次直轄市長選舉'}</h3>
    <table class="ep-history-table">
      <thead><tr><th>年</th><th>勝者</th><th>KMT</th><th>DPP</th><th>TPP</th></tr></thead>
      <tbody>${histRows}</tbody>
    </table>
    `}

    ${renderPresidentialBlock(v)}
  `;

  const modal = document.getElementById('hotspotDetailModal');
  if (!modal) return;
  document.getElementById('hotspotDetailTitle').textContent =
    `${v.cityName || ''} ${v.town || ''} ${v.village || ''}（priority ${v.priority}）`;
  const body = document.getElementById('hotspotDetailBody');
  body.innerHTML = html;
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function initPastEventsToggle(){
  const wrap = document.getElementById('pastEventsWrap');
  const btn = document.getElementById('pastEventsToggle');
  if (!btn || !wrap) return;
  btn.addEventListener('click', () => {
    const collapsed = wrap.classList.toggle('collapsed');
    btn.setAttribute('aria-expanded', String(!collapsed));
  });
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

// --------- Person-mention drilldown modal ---------
function openMentionModal(name){
  const modal = document.getElementById('mentionModal');
  if (!modal) return;
  const articles = (state.mentionArticles && state.mentionArticles[name]) || [];
  const windowLabel = mode === '7d' ? '近 7 日' : '近 24h';
  document.getElementById('mentionModalTitle').textContent = `${name}（${windowLabel} 提及 ${articles.length} 則）`;
  const body = document.getElementById('mentionModalBody');
  body.innerHTML = '';
  if (articles.length === 0){
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = '此時段沒有提及紀錄。';
    body.appendChild(p);
  } else {
    const ol = document.createElement('ol');
    ol.className = 'mention-list';
    articles.forEach(x => {
      const li = document.createElement('li');
      const co = Array.isArray(x.co_mentioned) ? x.co_mentioned : [];
      if (co.length > 0) li.classList.add('co-mention');
      const meta = document.createElement('span');
      meta.className = 'mention-meta';
      const t = (x.time || '').slice(5, 16);
      meta.textContent = `${t}　[${x.platform || '-'}]　`;
      li.appendChild(meta);
      if (co.length > 0) {
        const chip = document.createElement('span');
        chip.className = 'co-chip';
        chip.textContent = `🔗 共現：${co.join('、')}`;
        chip.title = '此篇同時提及多位市長';
        li.appendChild(chip);
        li.appendChild(document.createTextNode(' '));
      }
      const a = document.createElement('a');
      a.href = x.url; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = (x.title || '').trim() || '（無標題）';
      li.appendChild(a);
      ol.appendChild(li);
    });
    body.appendChild(ol);
    // 標題加上一行共現摘要
    const coCount = articles.filter(x => Array.isArray(x.co_mentioned) && x.co_mentioned.length).length;
    if (coCount > 0) {
      const note = document.createElement('p');
      note.className = 'mention-summary-note';
      note.textContent = `※ 其中 ${coCount} 則同時提及其他市長（已標記🔗）`;
      body.insertBefore(note, ol);
    }
  }
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeMentionModal(){
  const modal = document.getElementById('mentionModal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

function initMentionModal(){
  const modal = document.getElementById('mentionModal');
  if (!modal) return;
  document.getElementById('mentionModalClose')?.addEventListener('click', closeMentionModal);
  modal.addEventListener('click', (e) => {
    if (e.target?.dataset?.close === 'mention') closeMentionModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeMentionModal();
  });
}

// --------- Hotspot detail modal ---------
const PLATFORM_CHIP_CLASS = { facebook: 'fb', instagram: 'ig', threads: 'th' };
const PLATFORM_DISPLAY = { facebook: 'FB', instagram: 'IG', threads: 'Threads' };

function openHotspotDetailModal(h, markersByTitle){
  const modal = document.getElementById('hotspotDetailModal');
  if (!modal) return;
  const total = (h.news_count || 0) + (h.comment_count || 0);
  document.getElementById('hotspotDetailTitle').textContent = `${h.title || '事件'}（${total} 則）`;

  const body = document.getElementById('hotspotDetailBody');
  body.innerHTML = '';

  // 摘要列：等級 chip + 地點 + 平台 + 壽命
  // 從卡片/圖表開的「純清單」modal 不需要 level/place（會傳 null/undefined），
  // 此時整列只顯示 note 與 lifetime
  const meta = document.createElement('div');
  meta.className = 'hd-meta';
  const lifetime = formatLifetimeHint(h);
  const parts = [];
  if (h.level) parts.push(`<span class="hc-level-chip ${h.level}">${h.level.toUpperCase()}</span>`);
  if (h.place) parts.push(`<span class="hd-meta-place">📍 ${escapeHtml(h.place)}</span>`);
  if (h.platform) parts.push(`<span class="hd-meta-platform">${escapeHtml(h.platform)}</span>`);
  if (h.note) parts.push(`<span class="hd-meta-note">${escapeHtml(h.note)}</span>`);
  if (lifetime) parts.push(`<span class="hd-meta-life">⏳ ${escapeHtml(lifetime)}</span>`);
  meta.innerHTML = parts.join('');
  if (parts.length) body.appendChild(meta);

  // 「在地圖上定位」按鈕
  if (markersByTitle && markersByTitle[h.title]){
    const locateBtn = document.createElement('button');
    locateBtn.className = 'hd-locate-btn';
    locateBtn.type = 'button';
    locateBtn.textContent = '🗺️ 在地圖上定位 →';
    locateBtn.addEventListener('click', () => {
      const m = markersByTitle[h.title];
      if (m && incidentMap){
        closeHotspotDetailModal();
        incidentMap.setView(m.getLatLng(), 13, { animate: true });
        m.openPopup();
        document.getElementById('incidentMap')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    });
    body.appendChild(locateBtn);
  }

  const articles = Array.isArray(h.news_articles) ? h.news_articles : [];
  const comments = Array.isArray(h.comments) ? h.comments : [];

  // 新聞區塊
  const newsSec = document.createElement('section');
  newsSec.className = 'hd-section';
  newsSec.innerHTML = `<h3>📰 相關新聞（${articles.length} 則）</h3>`;
  if (articles.length === 0){
    newsSec.insertAdjacentHTML('beforeend', '<p class="hint">此事件目前沒有對應的新聞報導。</p>');
  } else {
    const ol = document.createElement('ol');
    ol.className = 'hd-news-list';
    let redCount = 0, yellowCount = 0;
    articles.forEach(x => {
      const li = document.createElement('li');
      // 嚴重度分級：red（公共安全/刑事）/ yellow（政治批評/環境）/ none
      const sev = x.severity || (x.is_negative ? 'yellow' : null);
      if (sev === 'red'){
        li.classList.add('hd-news-red');
        redCount += 1;
        const badge = document.createElement('span');
        badge.className = 'hd-news-badge hd-news-badge-red';
        badge.textContent = '🔴 紅燈';
        badge.title = '標題命中嚴重事件詞（刑事 / 公共安全 / 重大）';
        li.appendChild(badge);
      } else if (sev === 'yellow'){
        li.classList.add('hd-news-yellow');
        yellowCount += 1;
        const badge = document.createElement('span');
        badge.className = 'hd-news-badge hd-news-badge-yellow';
        badge.textContent = '🟡 黃燈';
        badge.title = '標題命中政治批評／環境問題詞';
        li.appendChild(badge);
      }
      const meta = document.createElement('span');
      meta.className = 'mention-meta';
      meta.textContent = `${(x.time || '').slice(5, 16)}　`;
      li.appendChild(meta);
      const a = document.createElement('a');
      a.href = x.url; a.target = '_blank'; a.rel = 'noopener';
      a.textContent = (x.title || '').trim() || '（無標題）';
      li.appendChild(a);
      ol.appendChild(li);
    });
    if (redCount > 0 || yellowCount > 0){
      const note = document.createElement('p');
      note.className = 'hint hd-neg-note';
      const parts = [];
      if (redCount > 0) parts.push(`🔴 紅燈 ${redCount} 則（刑事 / 公共安全 / 重大事件）`);
      if (yellowCount > 0) parts.push(`🟡 黃燈 ${yellowCount} 則（政治批評 / 環境問題）`);
      note.textContent = `※ ${parts.join('，')}`;
      newsSec.appendChild(note);
    }
    newsSec.appendChild(ol);
  }
  body.appendChild(newsSec);

  // 留言區塊
  const cmtSec = document.createElement('section');
  cmtSec.className = 'hd-section';
  cmtSec.innerHTML = `<h3>💬 相關留言（${comments.length} 則）</h3>`;
  if (comments.length === 0){
    cmtSec.insertAdjacentHTML('beforeend', '<p class="hint">此事件目前沒有對應的留言。</p>');
  } else {
    const ul = document.createElement('ul');
    ul.className = 'hd-comment-list';
    comments.forEach(c => {
      const li = document.createElement('li');
      li.className = 'hd-comment';
      const platCls = PLATFORM_CHIP_CLASS[c.platform] || '';
      const platName = PLATFORM_DISPLAY[c.platform] || c.platform;
      const sigCls = c.signal === 'red' ? 'red' : c.signal === 'yellow' ? 'yellow' : c.signal === 'green' ? 'green' : '';
      const time = c.time_text ? `<span class="hd-c-time">${escapeHtml(c.time_text)}</span>` : '';
      const author = c.author ? `<span class="hd-c-author">${escapeHtml(c.author)}</span>` : '';
      const sigChip = sigCls ? `<span class="light-chip ${sigCls}">${sigCls === 'red' ? '🔴' : sigCls === 'yellow' ? '🟡' : '🟢'}</span>` : '';
      const link = c.url ? `<a class="hd-c-link" href="${escapeHtml(c.url)}" target="_blank" rel="noopener">原文 →</a>` : '';
      li.innerHTML = `
        <div class="hd-c-hdr">
          <span class="hd-c-platform plat-${platCls}">${platName}</span>
          ${sigChip}
          ${author}
          ${time}
          ${link}
        </div>
        <div class="hd-c-text">${escapeHtml(c.text || '')}</div>
      `;
      ul.appendChild(li);
    });
    cmtSec.appendChild(ul);
  }
  body.appendChild(cmtSec);

  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
}

function closeHotspotDetailModal(){
  const modal = document.getElementById('hotspotDetailModal');
  if (!modal) return;
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

function initHotspotDetailModal(){
  const modal = document.getElementById('hotspotDetailModal');
  if (!modal) return;
  document.getElementById('hotspotDetailClose')?.addEventListener('click', closeHotspotDetailModal);
  modal.addEventListener('click', (e) => {
    if (e.target?.dataset?.close === 'hotspot') closeHotspotDetailModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modal.classList.contains('hidden')) closeHotspotDetailModal();
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

  // 卡片點擊 → 開 modal 顯示對應的新聞清單
  state.articles24h = d.articles_24h || [];
  state.articlesPrev24h = d.articles_prev_24h || [];
  state.articles7d = d.articles_7d || [];
  state.articlesPrev7d = d.articles_prev_7d || [];
  const isWeekMode = mode === '7d';
  const totalArticles  = () => isWeekMode ? state.articles7d : state.articles24h;
  const prevArticles   = () => isWeekMode ? state.articlesPrev7d : state.articlesPrev24h;
  const newsArticles   = () => totalArticles().filter(a => a.platform === 'news');
  bindCardClick('total24', isWeekMode ? '近 7 日聲量明細'  : '24h 聲量明細',
    isWeekMode ? '近 7 日所有與盧秀燕有關的事件' : '近 24 小時所有與盧秀燕有關的事件', totalArticles);
  bindCardClick('prev24',  isWeekMode ? '前 7 日聲量明細'  : '前 24h 聲量明細',
    isWeekMode ? '7-14 天前所有與盧秀燕有關的事件' : '24-48 小時前所有與盧秀燕有關的事件',
    prevArticles);
  bindCardClick('news24',  isWeekMode ? '7 日新聞量明細' : '今日新聞量明細',
    isWeekMode ? '近 7 日所有與盧秀燕有關的新聞' : '近 24 小時所有與盧秀燕有關的新聞', newsArticles);

  // 燈號 = max(volume-based anomaly level, 任一新聞 severity)
  // 解決外面顯示綠燈但裡面有 黃/紅 新聞的不一致問題
  const baseLevel = (m.anomaly||{}).level || '綠';
  const level = combineLights(baseLevel, totalArticles());
  document.getElementById('light').innerHTML = `<span class="badge ${level}">${LIGHT_ICON[level]||'🟢'} ${level}</span>`;

  const cmp = pick(d, 'mention_compare_24h', 'mention_compare_7d') || {};
  const names = Object.keys(cmp);
  const vals = names.map(n => cmp[n] || 0);
  document.getElementById('compare').textContent = names.map(n => `${n}：${cmp[n]||0}`).join(' ｜ ');
  state.mentionArticles = pick(d, 'mention_articles_24h', 'mention_articles_7d') || {};

  const byPlatform = pick(d, 'by_platform', 'by_platform_7d') || [];
  const ul = document.getElementById('platforms'); ul.innerHTML='';
  byPlatform.forEach(x=>{ const li=document.createElement('li'); li.textContent=`${x.platform}: ${x.count}`; ul.appendChild(li); });

  // Clickable social cards + alert + trend chart + red panel — all read from state
  renderSocialCards();
  updateAlertBanner();
  renderRedTrendChart();
  renderRedCommentsPanel();
  renderTopicHeat();
  renderIncidentMap(d);
  renderPastEvents();
  renderMediaFraming(d);
  renderElectionPriority();
  renderElectionForecast();
  renderElectionMap();
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

  const byHourRaw = pick(d, 'by_hour', 'by_hour_7d') || [];
  // 7d 模式聚合到「日」（過去 7 天的週幾）；24h 模式維持小時級
  const isWeek = mode === '7d';
  const dayWeekdayLabel = (d) => {
    // d = "2026-04-30"
    const t = new Date(d + 'T00:00+08:00');  // 假設 Asia/Taipei
    const wd = ['日','一','二','三','四','五','六'][t.getDay()];
    return `${d.slice(5)}（週${wd}）`;
  };
  let byHour;
  if (isWeek){
    // Aggregate by_hour_7d to per-day counts; ensure all 7 days present (zero-fill)
    const dayCounts = {};
    byHourRaw.forEach(h => {
      const day = (h.hour||'').slice(0, 10);
      if (!day) return;
      dayCounts[day] = (dayCounts[day] || 0) + (h.count || 0);
    });
    // Generate last 7 days in order
    const today = new Date(); today.setHours(0,0,0,0);
    const days = [];
    for (let i = 6; i >= 0; i--){
      const d2 = new Date(today.getTime() - i*86400000);
      const ymd = d2.toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
      days.push(ymd);
    }
    byHour = days.map(d => ({ hour: d, day: d, count: dayCounts[d] || 0 }));
  } else {
    byHour = byHourRaw;
  }

  // 燈號狀態與原因（可視化）
  const an = m.anomaly || {};
  const reasons = an.reasons || [];
  const es = d.event_stream || {};
  const minuteN = (es.minute || []).length;
  const hourN = (es.hour || []).length;
  const dayN = (es.day || []).length;
  const totalN = minuteN + hourN + dayN;
  const streamTxt = totalN === 0
    ? '✓ 24h 內無事件需處理（資料尚未抓到，或目前確實無新聞）'
    : `🚨 分鐘級 ${minuteN} ｜ ⚠️ 小時級 ${hourN} ｜ 📅 日級 ${dayN}`;
  const ls = document.getElementById('lightStatus');
  if(ls){ ls.innerHTML = `<span class="badge ${level}">${LIGHT_ICON[level]||'🟢'} ${isWeek ? '7 日燈號' : '今日燈號'}：${level}</span>`; }
  const lr = document.getElementById('lightReasons');
  if(lr){ lr.textContent = reasons.length ? `觸發原因：${reasons.join('；')}` : '觸發原因：無（目前屬常態）'; }
  const lstream = document.getElementById('lightStreams');
  if(lstream){
    const explainer = totalN === 0 ? '' : `
      <div class="hint" style="margin-top:6px;font-size:11px;line-height:1.7">
        <strong>分流邏輯</strong>：依新聞 severity 分到不同響應級別。
        <span style="color:#ff8a8a">🚨 分鐘級 = 紅燈事件</span>（刑事 / 公共安全 / 重大 — 候選人 / 服務處應在 30 分鐘內回應）；
        <span style="color:#ffb84d">⚠️ 小時級 = 黃燈事件</span>（政治批評 / 環境問題 — 當小時內擬好回應稿）；
        <span style="color:#9fb0ea">📅 日級 = 中性事件</span>（常態露出 — 日結時掃過即可，不必個別回應）。
      </div>`;
    lstream.innerHTML = `<span class="badge 綠">${streamTxt}</span>${explainer}`;
  }
  const lt = document.getElementById('lightTrend');
  if(lt){
    const avg = byHour.length ? byHour.reduce((a,b)=>a+(b.count||0),0)/byHour.length : 0;
    const renderClickable = (label, key, count, lv, kind /* 'hour' | 'day' */) => {
      const inner = `${label} ${LIGHT_ICON[lv]}${lv}（${count} 則）`;
      if (count > 0){
        return `<button type="button" class="light-item" data-${kind}="${escapeHtml(key)}" title="點擊查看當${kind === 'day' ? '日' : '小時'}新聞">${inner}</button>`;
      }
      return `<span class="light-item-empty" title="該${kind === 'day' ? '日' : '小時'}沒有新聞">${inner}</span>`;
    };
    if (isWeek){
      const items = byHour.map(x => {
        const dayArticles = (state.articles7d || []).filter(a => a.day === x.day);
        const lv = combineLights(lightLevelByCount(x.count || 0, avg), dayArticles);
        return renderClickable(dayWeekdayLabel(x.day), x.day, x.count || 0, lv, 'day');
      });
      lt.innerHTML = '近 7 日：' + items.join(' ｜ ');
    } else {
      const last = byHour.slice(-12);
      const items = last.map(x => {
        const hourArticles = (state.articles24h || []).filter(a => a.hour === x.hour);
        const lv = combineLights(lightLevelByCount(x.count || 0, avg), hourArticles);
        const hourLabel = (x.hour || '').slice(11, 16);
        return renderClickable(hourLabel, x.hour, x.count || 0, lv, 'hour');
      });
      lt.innerHTML = '近 12 小時：' + items.join(' ｜ ');
    }
  }

  hourChart = upsertChart(hourChart, document.getElementById('hourChart'), {
    type: isWeek ? 'bar' : 'line',
    data:{
      labels: isWeek
        ? byHour.map(x => dayWeekdayLabel(x.day))
        : byHour.map(x => (x.hour||'').slice(5, 16)),
      datasets:[{
        label:'聲量', data:byHour.map(x=>x.count||0),
        borderColor:'#7fc0ff', backgroundColor:isWeek ? '#5a79ff' : 'rgba(127,192,255,0.2)',
        tension:0.25, fill:!isWeek,
        pointRadius: isWeek ? 0 : 4,
        pointHoverRadius: isWeek ? 0 : 7,
        pointBackgroundColor:'rgba(127,192,255,0.4)',
        pointBorderColor:'#7fc0ff',
        pointHoverBackgroundColor:'#fff', pointHoverBorderColor:'#7fc0ff',
        borderRadius: isWeek ? 6 : 0,
      }],
    },
    options:{
      interaction: INDEX_HOVER,
      hover: INDEX_HOVER,
      plugins:{
        legend:{display:false},
        tooltip: darkTooltip({
          mode: 'index',
          displayColors: false,
          callbacks: { label: (ctx) => `聲量：${ctx.parsed.y}（點擊查看清單）` },
        }),
      },
      scales:{x:{ticks:{color:'#b9c3f2'}}, y:{ticks:{color:'#b9c3f2'}, beginAtZero:true}},
      onHover: (evt, els) => {
        const target = evt?.native?.target;
        if (target) target.style.cursor = els.length ? 'pointer' : 'default';
      },
      onClick: (evt, els) => {
        if (!els.length) return;
        const idx = els[0].index;
        if (isWeek){
          const dayKey = byHour[idx]?.day;
          if (!dayKey) return;
          const dayArticles = (state.articles7d || []).filter(a => a.day === dayKey);
          openArticlesModal(`${dayWeekdayLabel(dayKey)} 聲量明細`, `當日所有與盧秀燕有關的事件`, dayArticles);
        } else {
          const hourFull = byHour[idx]?.hour;
          if (!hourFull) return;
          const hourArticles = (state.articles24h || []).filter(a => a.hour === hourFull);
          const hourLabel = hourFull.slice(5, 16);
          openArticlesModal(`${hourLabel} 聲量明細`, `該小時內所有與盧秀燕有關的事件`, hourArticles);
        }
      },
    }
  });

  platformChart = upsertChart(platformChart, document.getElementById('platformChart'), {
    type:'doughnut',
    data:{ labels:byPlatform.map(x=>x.platform), datasets:[{data:byPlatform.map(x=>x.count), backgroundColor:['#4f8cff','#20c997','#ffc107','#e83e8c','#fd7e14','#6f42c1','#adb5bd']}] },
    options:{
      plugins:{
        legend:{labels:{color:'#b9c3f2'}},
        tooltip: darkTooltip({
          callbacks: {
            label: (ctx) => {
              const total = ctx.dataset.data.reduce((a,b)=>a+b, 0);
              const pct = total ? (ctx.parsed / total * 100).toFixed(1) : 0;
              return ` ${ctx.label}：${ctx.parsed}（${pct}%）（點擊查看清單）`;
            },
          },
        }),
      },
      onHover: (evt, els) => {
        const target = evt?.native?.target;
        if (target) target.style.cursor = els.length ? 'pointer' : 'default';
      },
      onClick: (evt, els) => {
        if (!els.length) return;
        const idx = els[0].index;
        const plat = byPlatform[idx]?.platform;
        if (!plat) return;
        const map = pick(d, 'latest_by_platform_24h', 'latest_by_platform_7d') || {};
        const items = (map[plat] || []).map(x => ({
          title: x.title, url: x.url, time: x.time,
        }));
        const modeLabel = mode === '7d' ? '近 7 日' : '近 24h';
        openArticlesModal(`平台分佈 — ${plat}（${modeLabel}）`,
                          `命中 4 位市長關鍵字，平台 = ${plat}`,
                          items);
      },
    }
  });

  mentionChart = upsertChart(mentionChart, document.getElementById('mentionChart'), {
    type:'bar',
    data:{
      labels:names,
      datasets:[{
        label:'提及數', data:vals,
        backgroundColor:['#20c997','#4f8cff','#ffc107','#e83e8c','#fd7e14'],
        borderRadius:4,
        hoverBackgroundColor:'#ffffff40',
      }],
    },
    options:{
      interaction: INDEX_HOVER,
      hover: INDEX_HOVER,
      plugins:{
        legend:{display:false},
        tooltip: darkTooltip({
          mode: 'index',
          displayColors: false,
          callbacks: { label: (ctx) => `提及：${ctx.parsed.y} 則（點擊查看清單）` },
        }),
      },
      scales:{x:{ticks:{color:'#b9c3f2'}}, y:{ticks:{color:'#b9c3f2'}, beginAtZero:true}},
      onHover: (evt, els) => {
        const target = evt?.native?.target;
        if (target) target.style.cursor = els.length ? 'pointer' : 'default';
      },
      onClick: (evt, els) => {
        if (!els.length) return;
        const idx = els[0].index;
        const name = names[idx];
        if (name) openMentionModal(name);
      },
    }
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

function applyModeLabels(){
  const isWeek = mode === '7d';
  // Active button highlight
  document.getElementById('mode24')?.classList.toggle('is-active', !isWeek);
  document.getElementById('mode7d')?.classList.toggle('is-active', isWeek);
  // 標題裡的 24h/24小時 文字統一替換成 7日
  document.querySelectorAll('[data-window-label]').forEach(el => {
    if (!el.dataset.origText) el.dataset.origText = el.textContent;
    if (isWeek){
      el.textContent = el.dataset.origText.replaceAll('24h', '7日').replaceAll('24小時', '7日');
    } else {
      el.textContent = el.dataset.origText;
    }
  });
  // 「前 24h」card 比較期間 — 7d 模式下要說「前 7 日」
  document.querySelectorAll('[data-window-label-prev]').forEach(el => {
    if (!el.dataset.origText) el.dataset.origText = el.textContent;
    el.textContent = isWeek ? '前 7 日聲量' : el.dataset.origText;
  });
  // 「今日新聞量」card 標題 — 7d 顯示「7 日新聞量」
  document.querySelectorAll('[data-window-label-news]').forEach(el => {
    if (!el.dataset.origText) el.dataset.origText = el.textContent;
    el.textContent = isWeek ? '7 日新聞量' : el.dataset.origText;
  });
}

function initLightTrendClicks(){
  const lt = document.getElementById('lightTrend');
  if (!lt || lt.dataset.boundClicks === '1') return;
  lt.dataset.boundClicks = '1';
  lt.addEventListener('click', (e) => {
    const btn = e.target.closest('button.light-item');
    if (!btn) return;
    const day = btn.dataset.day;
    const hour = btn.dataset.hour;
    if (day){
      const arts = (state.articles7d || []).filter(a => a.day === day);
      // dayWeekdayLabel 在 run() scope；這裡 inline 算一次
      const t = new Date(day + 'T00:00+08:00');
      const wd = ['日','一','二','三','四','五','六'][t.getDay()];
      openArticlesModal(`${day.slice(5)}（週${wd}） 燈號明細`, `當日所有與盧秀燕有關的事件`, arts);
    } else if (hour){
      const arts = (state.articles24h || []).filter(a => a.hour === hour);
      openArticlesModal(`${hour.slice(5, 16)} 燈號明細`, `該小時內所有與盧秀燕有關的事件`, arts);
    }
  });
}

function initModes(){
  const b24 = document.getElementById('mode24');
  const b7 = document.getElementById('mode7d');
  if(b24) b24.onclick = async ()=>{ mode='24h'; applyModeLabels(); await run(); };
  if(b7) b7.onclick = async ()=>{ mode='7d'; applyModeLabels(); await run(); };
  applyModeLabels();  // initial
}

initCollapsibles();
initLightTrendClicks();
initMentionModal();
initHotspotDetailModal();
initPastEventsToggle();
initModes();
initModal();
initTopicHeat();
// run() 失敗時 console.error，避免再發生 silent failure
run().catch(e => console.error('run() failed:', e));
setInterval(() => run().catch(e => console.error('run() interval failed:', e)), 60000);
