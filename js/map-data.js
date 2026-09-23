/*
 * 外掃區地圖資料
 * ------------------------------------------------------------
 * 走廊以「南 → 北」為長度方向，全長 1100 單位（對應原始地圖的左 → 右）。
 * 手機畫面中：上 = 南、下 = 北、右 = 西側（警衛室側）、左 = 東側（司令台側）。
 *
 * ⚠ 同學姓名不放在這裡，而是加密存在 js/roster.enc.js，
 *   要修改名單請用 tools/roster.html（需要密碼）。
 *
 * items 欄位：
 *   id      唯一代號（名單依這個代號對應負責同學；改了會影響試算表紀錄對應）
 *   type    glass 公佈欄玻璃 / fountain 飲水機 / sink 洗手槽 / platform 水泥平台 / floor 牆壁地板
 *   side    W 西側牆邊、E 東側牆邊、out-W 西側牆外、floor 整段走廊
 *   from/to 在走廊上的位置（0 ~ 1100）；floor 會自動使用整個區段
 *   chipAt  （floor 專用）「牆壁地板」標籤放的位置，避開其他物件
 *   section 所屬區段 id
 *
 * 換學期或換外掃區時，改這個檔案（位置）和名單（tools/roster.html）即可。
 */
window.MAP_DATA = {
  title: '外掃區檢查',
  length: 1100,

  sections: [
    { id: 'L', label: '料區', color: 'pink', from: 0, to: 550 },
    { id: 'D', label: '多區', color: 'green', from: 550, to: 1100 },
  ],

  landmarks: [
    { name: '司令台', side: 'E', at: 550 },
    { name: '警衛室', side: 'W', at: 1080 },
  ],

  items: [
    // ── 料區 ──
    { id: 'L-glass-w1', type: 'glass', side: 'W', from: 115, to: 200, section: 'L' },
    { id: 'L-fountain', type: 'fountain', side: 'W', from: 220, to: 260, section: 'L' },
    { id: 'L-glass-w2', type: 'glass', side: 'W', from: 278, to: 361, section: 'L' },
    { id: 'L-glass-w3', type: 'glass', side: 'W', from: 388, to: 472, section: 'L' },
    { id: 'L-sink-1', type: 'sink', side: 'E', from: 140, to: 180, section: 'L' },
    { id: 'L-platform', type: 'platform', side: 'E', from: 256, to: 292, section: 'L' },
    { id: 'L-sink-2', type: 'sink', side: 'E', from: 310, to: 351, section: 'L' },
    { id: 'L-glass-e1', type: 'glass', side: 'E', from: 400, to: 470, section: 'L' },
    { id: 'L-floor', type: 'floor', side: 'floor', section: 'L', chipAt: 60 },

    // ── 多區 ──
    { id: 'D-glass-w1', type: 'glass', side: 'W', from: 631, to: 714, section: 'D' },
    { id: 'D-fountain', type: 'fountain', side: 'W', from: 804, to: 843, section: 'D' },
    { id: 'D-platform', type: 'platform', side: 'out-W', from: 862, to: 900, section: 'D' },
    { id: 'D-glass-w2', type: 'glass', side: 'W', from: 937, to: 1008, section: 'D' },
    { id: 'D-glass-e1', type: 'glass', side: 'E', from: 631, to: 714, section: 'D', double: true },
    { id: 'D-sink-1', type: 'sink', side: 'E', from: 733, to: 774, section: 'D' },
    { id: 'D-sink-2', type: 'sink', side: 'E', from: 883, to: 925, section: 'D' },
    { id: 'D-floor', type: 'floor', side: 'floor', section: 'D', chipAt: 600 },
  ],

  typeNames: {
    glass: '公佈欄玻璃',
    fountain: '飲水機',
    sink: '洗手槽',
    platform: '水泥平台',
    floor: '牆壁地板掃拖',
  },
};
