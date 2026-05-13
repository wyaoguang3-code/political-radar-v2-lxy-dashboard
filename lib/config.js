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
    SUPABASE_URL:      'https://ypkhjcbanfizysdnayee.supabase.co',
    SUPABASE_ANON_KEY: 'sb_publishable_ZqEDonY9EZvB55YVQzI9vQ_nQPIRDCB',
  };
})(typeof window !== 'undefined' ? window : globalThis);
