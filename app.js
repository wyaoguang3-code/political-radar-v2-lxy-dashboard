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

function upsertChart(instance, ctx, config){
  if(instance){ instance.data=config.data; instance.options=config.options; instance.update(); return instance; }
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
  const CITY_ORDER = ['台中', '台北', '高雄', '其他'];
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
  const PAST_CITY_ORDER = ['台中', '台北', '高雄', '其他'];

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
function bindCardClick(elemId, title, note, getArticlesFn){
  const num = document.getElementById(elemId);
  if (!num) return;
  const card = num.closest('.card');
  if (!card || card.dataset.clickBound === '1') return;
  card.dataset.clickBound = '1';
  card.classList.add('card-clickable');
  card.addEventListener('click', () => {
    const articles = getArticlesFn() || [];
    openArticlesModal(title, note, articles);
  });
}

async function openPastEventModal(h, dateStr){
  // Lazy-load 該日完整 archive；找不到就 fallback 到 index 裡的 sample_titles
  let archiveEvents = _pastArchiveCache[dateStr];
  if (archiveEvents === undefined){
    const archive = await fetchJSON(`./hotspot_archive/${dateStr}.json`);
    archiveEvents = (archive && Array.isArray(archive.hotspots)) ? archive.hotspots : null;
    _pastArchiveCache[dateStr] = archiveEvents;
  }
  let news = [];
  let comments = [];
  if (archiveEvents){
    const found = archiveEvents.find(x => x.title === h.title);
    if (found){
      news = found.news_articles || [];
      comments = found.comments || [];
    }
  } else if (Array.isArray(h.sample_titles) && h.sample_titles.length){
    // 舊格式 fallback：只剩標題沒 url
    news = h.sample_titles.map(t => ({ title: t, url: '', time: '' }));
  }

  const fakeHotspot = {
    title: `[${dateStr}] ${h.title || '事件'}`,
    place: h.place,
    level: h.level,
    source: (news.length ? 'news' : '') + (comments.length ? ((news.length ? ' + ' : '') + 'comment') : ''),
    platform: '',
    note: `${dateStr} 命中 ${(h.news_count || 0) + (h.comment_count || 0)} 則（新聞 ${h.news_count || 0}、留言 ${h.comment_count || 0}）`,
    news_count: h.news_count || 0,
    comment_count: h.comment_count || 0,
    news_articles: news,
    comments: comments,
    news_full_expires_at: null,  // 歷史不算壽命
  };
  openHotspotDetailModal(fakeHotspot, null);
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
    articles.forEach(x => {
      const li = document.createElement('li');
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
  bindCardClick('total24', '24h 聲量明細', '近 24 小時所有與盧秀燕有關的事件', () => state.articles24h);
  bindCardClick('prev24',  '前 24h 聲量明細', '24-48 小時前所有與盧秀燕有關的事件', () => state.articlesPrev24h);
  bindCardClick('news24',  '今日新聞量明細', '近 24 小時所有與盧秀燕有關的新聞', () => state.articles24h.filter(a => a.platform === 'news'));

  const level = (m.anomaly||{}).level || '綠';
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
    data:{
      labels:byHour.map(x=>(x.hour||'').slice(5,16)),
      datasets:[{
        label:'聲量', data:byHour.map(x=>x.count||0),
        borderColor:'#7fc0ff', backgroundColor:'rgba(127,192,255,0.2)',
        tension:0.25, fill:true,
        pointRadius:4, pointHoverRadius:7,                 // 視覺提示可點
        pointBackgroundColor:'rgba(127,192,255,0.4)',
        pointBorderColor:'#7fc0ff',
        pointHoverBackgroundColor:'#fff', pointHoverBorderColor:'#7fc0ff',
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
        const hourFull = byHour[idx]?.hour;  // e.g. "2026-05-06 14:00"
        if (!hourFull) return;
        const hourArticles = (state.articles24h || []).filter(a => a.hour === hourFull);
        const hourLabel = hourFull.slice(5, 16);  // 顯示用的「MM-DD HH:00」
        openArticlesModal(`${hourLabel} 聲量明細`, `該小時內所有與盧秀燕有關的事件`, hourArticles);
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

function initModes(){
  const b24 = document.getElementById('mode24');
  const b7 = document.getElementById('mode7d');
  if(b24) b24.onclick = async ()=>{ mode='24h'; await run(); };
  if(b7) b7.onclick = async ()=>{ mode='7d'; await run(); };
}

initCollapsibles();
initMentionModal();
initHotspotDetailModal();
initPastEventsToggle();
initModes();
initModal();
initTopicHeat();
// run() 失敗時 console.error，避免再發生 silent failure
run().catch(e => console.error('run() failed:', e));
setInterval(() => run().catch(e => console.error('run() interval failed:', e)), 60000);
