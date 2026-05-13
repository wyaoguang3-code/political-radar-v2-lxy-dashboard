// dashboard/lib/db.js
// 前端讀 Supabase 的 wrapper，掛到 window.LxyDB 全域。
//
// 設計：
//   - 跟現有 fetchJSON('./xxx.json') 並存、不替換。先讓兩邊資料形狀對得起來。
//   - 每個方法回傳的形狀盡量跟對應的 JSON 檔一致，未來 app.js 切換時不用改太多
//     consumer 程式碼。
//   - 失敗（網路、RLS 擋住、table 不存在）都會 throw，呼叫端可以 try/catch
//     fallback 回 flat JSON。
//
// 依賴（要先載入）：
//   1. https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2  (UMD，提供 window.supabase)
//   2. ./lib/config.js    (定義 window.LxyConfig)
//
// 用法（瀏覽器）：
//   const db = LxyDB.client();
//   const comments = await LxyDB.recentComments('facebook', 50);
//   const signals  = await LxyDB.signalsByPlatform();

(function (root) {
  'use strict';

  const PLATFORM_KEYS = ['facebook', 'instagram', 'threads'];

  // -----------------------------------------------------------------------
  // Client 初始化（lazy + cached）
  // -----------------------------------------------------------------------
  let _client = null;
  function client() {
    if (_client) return _client;
    if (typeof root.supabase === 'undefined' || !root.supabase.createClient) {
      throw new Error(
        'supabase-js UMD 沒載入。請在 db.js 前面加：\n' +
        '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>'
      );
    }
    const cfg = root.LxyConfig;
    if (!cfg || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
      throw new Error('window.LxyConfig 沒設好（lib/config.js 應該先載入）');
    }
    _client = root.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
      auth: { persistSession: false },   // 前端唯讀、不需要 session
      realtime: { params: { eventsPerSecond: 5 } },
    });
    return _client;
  }

  // -----------------------------------------------------------------------
  // 1. 留言：對應 comments_facebook.json / comments_instagram.json / comments_threads.json
  //    回傳 list of {author, text, signal, signal_zh, signal_score, time_text, url, kind}
  // -----------------------------------------------------------------------
  async function recentComments(platform, limit) {
    if (typeof limit !== 'number') limit = 100;
    const c = client();
    const { data, error } = await c
      .from('social_comments')
      .select('author, text, signal, signal_zh, signal_score, time_text, url, kind, first_seen_at')
      .eq('platform', platform)
      .order('first_seen_at', { ascending: false })
      .limit(limit);
    if (error) throw error;
    // 把 first_seen_at 拿掉以符合舊 JSON 形狀（舊檔沒這欄）
    return (data || []).map(function (r) {
      const { first_seen_at, ...rest } = r;
      return rest;
    });
  }

  // -----------------------------------------------------------------------
  // 2. 燈號統計：對應 social_signals.json
  //    aggregation 在 client 端做（1.4K rows、輕量）
  //    回傳 { facebook: {red, yellow, green, total, *_pct, updated_at}, ig: {...}, threads: {...} }
  // -----------------------------------------------------------------------
  async function signalsByPlatform() {
    const c = client();
    const { data, error } = await c
      .from('social_comments')
      .select('platform, signal, first_seen_at');
    if (error) throw error;
    const out = {};
    PLATFORM_KEYS.forEach(function (p) {
      out[p] = { red: 0, yellow: 0, green: 0, total: 0, updated_at: null };
    });
    (data || []).forEach(function (r) {
      const bucket = out[r.platform];
      if (!bucket) return;
      bucket.total += 1;
      if (r.signal === 'red')    bucket.red += 1;
      if (r.signal === 'yellow') bucket.yellow += 1;
      if (r.signal === 'green')  bucket.green += 1;
      if (!bucket.updated_at || r.first_seen_at > bucket.updated_at) {
        bucket.updated_at = r.first_seen_at;
      }
    });
    PLATFORM_KEYS.forEach(function (p) {
      const b = out[p];
      const t = b.total || 1;
      b.red_pct    = Math.round((b.red    / t) * 10000) / 100;
      b.yellow_pct = Math.round((b.yellow / t) * 10000) / 100;
      b.green_pct  = Math.round((b.green  / t) * 10000) / 100;
    });
    return out;
  }

  // -----------------------------------------------------------------------
  // 3. 事件 (文章/貼文)：對應 social_events 部分查詢
  //    options: { platform, status='active', sinceHours, limit=200 }
  // -----------------------------------------------------------------------
  async function recentEvents(options) {
    options = options || {};
    const limit  = options.limit  || 200;
    const status = options.status || 'active';
    let q = client()
      .from('social_events')
      .select('event_id, platform, source_id, author_name, title, text, published_at, url, risk_level, severity_llm, matched_keywords')
      .eq('status', status)
      .order('published_at', { ascending: false, nullsFirst: false })
      .limit(limit);
    if (options.platform) q = q.eq('platform', options.platform);
    if (options.sinceHours) {
      const cutoff = new Date(Date.now() - options.sinceHours * 3600 * 1000).toISOString();
      q = q.gte('published_at', cutoff);
    }
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
  }

  // -----------------------------------------------------------------------
  // 4. 留言歷史 archive：對應 comments_archive 部分查詢
  // -----------------------------------------------------------------------
  async function archiveByDate(platform, dateStr) {
    const c = client();
    const { data, error } = await c
      .from('comments_archive')
      .select('author, text, signal, signal_zh, signal_score, url, kind, time_text, published_at, scrape_at')
      .eq('platform', platform)
      .eq('published_date', dateStr)
      .order('scrape_at', { ascending: false })
      .limit(500);
    if (error) throw error;
    return data || [];
  }

  // -----------------------------------------------------------------------
  // 5. Sources：對應 sources list
  // -----------------------------------------------------------------------
  async function listSources(enabledOnly) {
    const c = client();
    let q = c.from('sources').select('source_id, platform, name, category, priority, enabled, dedup_group');
    if (enabledOnly) q = q.eq('enabled', true);
    const { data, error } = await q.order('platform').order('priority');
    if (error) throw error;
    return data || [];
  }

  // -----------------------------------------------------------------------
  // 6. Hotspots：對應 hotspots table（每日議題熱點）
  // -----------------------------------------------------------------------
  async function listHotspots(daysBack) {
    if (typeof daysBack !== 'number') daysBack = 14;
    const cutoff = new Date(Date.now() - daysBack * 86400000)
      .toISOString().slice(0, 10);
    const c = client();
    const { data, error } = await c
      .from('hotspots')
      .select('hotspot_id, date, topic, keywords, event_count, comment_count, red_count, intensity, metadata, generated_at')
      .gte('date', cutoff)
      .order('date', { ascending: false })
      .order('intensity', { ascending: false, nullsFirst: false });
    if (error) throw error;
    return data || [];
  }

  // -----------------------------------------------------------------------
  // 7. Health probe — 簡單戳一下表確認連得到
  // -----------------------------------------------------------------------
  async function ping() {
    const c = client();
    const t0 = performance.now();
    const { error, count } = await c
      .from('sources')
      .select('*', { count: 'exact', head: true });
    if (error) throw error;
    return {
      ok: true,
      sources_count: count,
      elapsed_ms: Math.round(performance.now() - t0),
    };
  }

  // -----------------------------------------------------------------------
  // 8. Realtime subscribe (給未來推播用、Phase B 才接)
  //    傳 onInsert(callback) 訂閱 social_events 新進；回傳 unsubscribe fn。
  // -----------------------------------------------------------------------
  function subscribeNewEvents(onInsert) {
    const c = client();
    const channel = c
      .channel('events-stream')
      .on('postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'social_events' },
          function (payload) { onInsert(payload.new); })
      .subscribe();
    return function () { c.removeChannel(channel); };
  }

  // -----------------------------------------------------------------------
  // Export
  // -----------------------------------------------------------------------
  root.LxyDB = {
    client:             client,
    recentComments:     recentComments,
    signalsByPlatform:  signalsByPlatform,
    recentEvents:       recentEvents,
    archiveByDate:      archiveByDate,
    listSources:        listSources,
    listHotspots:       listHotspots,
    ping:               ping,
    subscribeNewEvents: subscribeNewEvents,
  };
})(typeof window !== 'undefined' ? window : globalThis);
