let hourChart, platformChart, mentionChart;
let mode = '24h';

const LIGHT_ICON = { '紅':'🔴', '黃':'🟡', '綠':'🟢' };
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

async function run(){
  const res = await fetch('./data.json?t='+Date.now());
  const d = await res.json();

  let socialSignals = null;
  try {
    const sres = await fetch('./social_signals.json?t='+Date.now());
    if (sres.ok) socialSignals = await sres.json();
  } catch {}

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

  const sigWrap = document.getElementById('socialSignals');
  if (sigWrap) {
    sigWrap.innerHTML = '';
    const platforms = ['facebook', 'instagram', 'threads'];
    platforms.forEach((p) => {
      const s = (socialSignals && socialSignals[p]) || { total: 0, red: 0, yellow: 0, green: 0, updated_at: '-' };
      const card = document.createElement('div');
      card.className = 'social-card';
      card.innerHTML = `
        <h3>${p.toUpperCase()}（總數 ${s.total || 0}）</h3>
        <div class="social-row"><span class="tag">🔴 紅燈</span><strong>${s.red || 0}</strong></div>
        <div class="social-row"><span class="tag">🟡 黃燈</span><strong>${s.yellow || 0}</strong></div>
        <div class="social-row"><span class="tag">🟢 綠燈</span><strong>${s.green || 0}</strong></div>
        <div class="social-row" style="opacity:.75;font-size:12px"><span>更新</span><span>${s.updated_at || '-'}</span></div>
      `;
      sigWrap.appendChild(card);
    });
  }

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

  // 盧秀燕社群留言燈號（FB / IG / Threads）
  const socialWrap = document.getElementById('socialSignals');
  if (socialWrap) {
    const ss = d.social_signals || {};
    const platforms = ['facebook','instagram','threads'];
    const labels = { facebook: 'Facebook', instagram: 'Instagram', threads: 'Threads' };
    socialWrap.innerHTML = '';
    platforms.forEach((k) => {
      const s = ss[k] || {};
      const total = Number(s.total || 0);
      const green = Number(s.green || 0);
      const yellow = Number(s.yellow || 0);
      const red = Number(s.red || 0);
      const card = document.createElement('div');
      card.className = 'social-card';
      card.innerHTML = `
        <h3>${labels[k]}</h3>
        <div class="social-row"><span>總留言</span><b>${total}</b></div>
        <div class="social-row"><span class="tag">🟢 綠燈</span><b>${green}</b></div>
        <div class="social-row"><span class="tag">🟡 黃燈</span><b>${yellow}</b></div>
        <div class="social-row"><span class="tag">🔴 紅燈</span><b>${red}</b></div>
      `;
      socialWrap.appendChild(card);
    });
  }
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
run();
setInterval(run,60000);
