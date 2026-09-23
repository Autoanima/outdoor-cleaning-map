/*
 * 外掃區地圖資料（只有位置，不含同學姓名）
 * ------------------------------------------------------------
 * 走廊以「南 → 北」為長度方向，全長 1100 單位（對應原始地圖的左 → 右）。
 * 手機畫面中：上 = 南、下 = 北、右 = 西側、左 = 東側。
 *
 * 誰負責哪個工作、檢查人是誰，在網頁的「⚙ 設定 → 人員設定」用下拉選單指定，
 * 存在 Google 試算表的「工作分配」工作表，不會出現在 GitHub 上。
 *
 * items 欄位：
 *   id      物件代號（改了會影響試算表紀錄對應）
 *   type    glass 公佈欄玻璃 / fountain 飲水機 / sink 洗手槽 / platform 水泥平台 / floor 牆壁地板
 *   side    W 西側牆邊、E 東側牆邊、strip-W / strip-E 兩側的紫色水泥平台、floor 整段走廊
 *   from/to 在走廊上的位置（0 ~ 1100）；floor 與水泥平台會自動使用整段
 *   section 所屬區段 id（水泥平台跨兩區，不填）
 *   job     屬於哪一個工作範圍（見下方 jobs）
 *   chipAt  （floor 專用）「牆壁地板」標籤放的位置，避開其他物件
 *
 * jobs：一個工作範圍 = 一位（或 slots 位）同學負責的物件。
 */
window.MAP_DATA = {
  title: '外掃區檢查',
  length: 1100,

  sections: [
    { id: 'S', label: '南區', color: 'pink', from: 0, to: 550 },
    { id: 'N', label: '北區', color: 'green', from: 550, to: 1100 },
  ],

  sides: {
    E: { name: '東側', note: '國中部區' },
    W: { name: '西側', note: '垃圾子車區' },
  },

  landmarks: [
    { name: '司令台', side: 'E', at: 550 },
    { name: '警衛室', side: 'W', at: 1080 },
  ],

  // 檢查人：導師 + 每個區段一位
  teacherLabel: '導師',
  inspectorSlots: [
    { id: 'I1', label: '南區檢查人' },
    { id: 'I2', label: '北區檢查人' },
  ],

  jobs: [
    { id: 'J01', slots: 1 },
    { id: 'J02', slots: 1 },
    { id: 'J03', slots: 1 },
    { id: 'J04', slots: 1 },
    { id: 'J05', slots: 1 },
    { id: 'J06', slots: 2 },
    { id: 'J07', slots: 1 },
    { id: 'J08', slots: 1 },
    { id: 'J09', slots: 1 },
    { id: 'J10', slots: 1 },
    { id: 'J11', slots: 1 },
    { id: 'J12', slots: 2 },
  ],

  items: [
    // ── 兩側紫色長條：水泥平台 ──
    { id: 'P-E', type: 'platform', side: 'strip-E', job: 'J02' },
    { id: 'P-W', type: 'platform', side: 'strip-W', job: 'J08' },

    // ── 南區 ──
    { id: 'S-glass-w1', type: 'glass', side: 'W', from: 115, to: 200, section: 'S', job: 'J01' },
    { id: 'S-fountain', type: 'fountain', side: 'W', from: 220, to: 260, section: 'S', job: 'J02' },
    { id: 'S-glass-w2', type: 'glass', side: 'W', from: 278, to: 361, section: 'S', job: 'J01' },
    { id: 'S-glass-w3', type: 'glass', side: 'W', from: 388, to: 472, section: 'S', job: 'J03' },
    { id: 'S-sink-1', type: 'sink', side: 'E', from: 140, to: 180, section: 'S', job: 'J04' },
    { id: 'S-sink-2', type: 'sink', side: 'E', from: 310, to: 351, section: 'S', job: 'J05' },
    { id: 'S-glass-e1', type: 'glass', side: 'E', from: 400, to: 470, section: 'S', job: 'J03' },
    { id: 'S-floor', type: 'floor', side: 'floor', section: 'S', chipAt: 60, job: 'J06' },

    // ── 北區 ──
    { id: 'N-glass-w1', type: 'glass', side: 'W', from: 631, to: 714, section: 'N', job: 'J07' },
    { id: 'N-fountain', type: 'fountain', side: 'W', from: 804, to: 843, section: 'N', job: 'J08' },
    { id: 'N-glass-w2', type: 'glass', side: 'W', from: 937, to: 1008, section: 'N', job: 'J07' },
    { id: 'N-glass-e1', type: 'glass', side: 'E', from: 631, to: 714, section: 'N', job: 'J09', double: true },
    { id: 'N-sink-1', type: 'sink', side: 'E', from: 733, to: 774, section: 'N', job: 'J10' },
    { id: 'N-sink-2', type: 'sink', side: 'E', from: 883, to: 925, section: 'N', job: 'J11' },
    { id: 'N-floor', type: 'floor', side: 'floor', section: 'N', chipAt: 600, job: 'J12' },
  ],

  typeNames: {
    glass: '公佈欄玻璃',
    fountain: '飲水機',
    sink: '洗手槽',
    platform: '水泥平台',
    floor: '牆壁地板掃拖',
  },
};
