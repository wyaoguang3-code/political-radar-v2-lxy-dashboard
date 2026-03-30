let hourChart, platformChart, mentionChart;
let mode = '24h';

function upsertChart(instance, ctx, config){
  if(instance){ instance.data=config.data; instance.options=config.options; instance.update(); return instance; }
  return new Chart(ctx, config);
}

function pick(d, key24, key7){ return mode==='7d' ? (d[key7] ?? d[key24]) : d[key24]; }

async function run(){
  const res = await fetch('./data.json?t='+Date.now());
  const d = await res.json();

  const m = pick(d, 'metrics', 'metrics_7d') || {};
  document.getElementById('updated').textContent = '更新時間：' + new Date(d.generated_at).toLocaleString('zh-TW',{hour12:false});
  document.getElementById('modeHint').textContent = mode==='7d' ? '（近7日聚合）' : '（近24h）';
  document.getElementById('total24').textContent = m.total ?? m.total_24h ?? '-';
  document.getElementById('prev24').textContent = m.prev ?? m.prev_24h ?? '-';
  document.getElementById('growth').textContent = m.growth_pct==null ? '-' : `${m.growth_pct}%`;
  document.getElementById('news24').textContent = m.news ?? m.news_24h ?? '-';

  const level = (m.anomaly||{}).level || '綠';
  document.getElementById('light').innerHTML = `<span class="badge ${level}">${level}</span>`;

  const cmp = pick(d, 'mention_compare_24h', 'mention_compare_7d') || {};
  const z = cmp['張嘉郡']||0, l = cmp['劉建國']||0;
  document.getElementById('compare').textContent = `張嘉郡：${z} ｜ 劉建國：${l}`;

  const byPlatform = pick(d, 'by_platform', 'by_platform_7d') || [];
  const ul = document.getElementById('platforms'); ul.innerHTML='';
  byPlatform.forEach(x=>{ const li=document.createElement('li'); li.textContent=`${x.platform}: ${x.count}`; ul.appendChild(li); });

  const topNews = pick(d, 'top_news', 'top_news_7d') || [];
  const news = document.getElementById('news'); news.innerHTML='';
  topNews.slice(0,12).forEach(x=>{
    const li=document.createElement('li');
    const a=document.createElement('a');
    a.href=x.url; a.target='_blank'; a.rel='noopener';
    a.textContent=(x.title || x.url) + (x.time ? `（${x.time.slice(5,16)}）` : '');
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
        a.textContent=(x.title||x.url) + (x.time ? `（${x.time.slice(5,16)}）` : '');
        li.appendChild(a); ol.appendChild(li);
      });
      box.appendChild(ol); platformDetail.appendChild(box);
    });
  }

  function renderList(elId, arr){
    const el=document.getElementById(elId); if(!el) return; el.innerHTML='';
    (arr||[]).forEach(x=>{ const li=document.createElement('li'); const a=document.createElement('a'); a.href=x.url; a.target='_blank'; a.rel='noopener'; a.textContent=(x.title||x.url)+(x.time?`（${x.time.slice(5,16)}）`:''); li.appendChild(a); el.appendChild(li); });
  }
  const ps = d.person_sections || {};
  renderList('zhangFb', (ps['張嘉郡']||{}).facebook || []);
  renderList('zhangNews', (ps['張嘉郡']||{}).news || []);
  renderList('liuFb', (ps['劉建國']||{}).facebook || []);
  renderList('liuNews', (ps['劉建國']||{}).news || []);

  const byHour = pick(d, 'by_hour', 'by_hour_7d') || [];
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
    data:{ labels:['張嘉郡','劉建國'], datasets:[{data:[z,l], backgroundColor:['#20c997','#4f8cff']}] },
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
run();
setInterval(run,60000);
