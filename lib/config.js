// dashboard/lib/config.js
// Supabase 公開連線參數（前端用 anon key，RLS 擋掉寫入；可以安全放在 client）
//
// 別放 service_role key 到這裡！
// service_role key 只能放 .env、給 cron 用、走後端。
//
// 怎麼確認自己拿的是 anon 不是 service：
//   - anon key 開頭通常是 'sb_publishable_...' 或 'eyJ...' 但 role 欄位是 "anon"
//   - service_role 開頭也是 'eyJ...' 但 role 欄位是 "service_role"
//   - 想驗：到 https://jwt.io 貼進去看 payload.role
(function (root) {
  root.LxyConfig = {
    // === 後端連線（換 Supabase project 時改這兩個）===
    SUPABASE_URL:      'https://ypkhjcbanfizysdnayee.supabase.co',
    SUPABASE_ANON_KEY: 'sb_publishable_ZqEDonY9EZvB55YVQzI9vQ_nQPIRDCB',

    // === 客戶身分（換政治人物時改 CUSTOMER block）===
    // 未來「同一份 code、多 客戶部署」的核心：每客戶各自 fork 後改這裡就完成
    // 對應後端的 Postgres _lu_filter 也要對應 person.name (但那是另一個 migration、不在前端)
    CUSTOMER: {
      // 政治人物名 — 顯示在 dashboard 標題 + LxyDB 內部 filter 用
      NAME:        '盧秀燕',
      // 別名 (substring) — 用來偵測「文章是否提及該人」
      ALIASES:     ['盧秀燕', '秀燕', '秀燕盧'],
      // Dashboard title — 顯示在 <title> 跟 <h1>
      DASHBOARD_TITLE: '政治戰情儀表板（lxy）',
      // (可選) 比對的競品政治人物 — 留給 mention_compare / voice_breakdown 用
      COMPARE_TARGETS: ['蔣萬安', '蔡其昌', '陳其邁'],
    },
  };
})(typeof window !== 'undefined' ? window : globalThis);
