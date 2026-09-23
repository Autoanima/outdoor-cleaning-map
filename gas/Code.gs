/**
 * 外掃區檢查 — Google Apps Script 後端
 * ------------------------------------------------------------
 * 1. 在 Google 試算表中：擴充功能 → Apps Script，把這整份貼上。
 * 2. 修改下方 CONFIG（TOKEN 就是網頁的開啟密碼）。
 * 3. 執行一次 setup()（授權後會建立工作表、扣分統計與按鈕）。
 * 4. 部署 → 新增部署作業 → 類型「網頁應用程式」
 *      執行身分：我　／　誰可以存取：所有人
 *    複製「網頁應用程式網址」（…/exec）填到網站的 config.js。
 * 修改程式後要「管理部署作業 → 編輯 → 版本：新版本」才會生效。
 *
 * 試算表只記錄「不好」的處所：日期、處所、負責同學、說明、照片（可點開）。
 * 「扣分統計」工作表按「計算扣分」按鈕（或勾選方塊）即可加總每位同學的扣分。
 */
const CONFIG = {
  TOKEN: '請改成你的密碼',              // 網頁的開啟密碼（只改你 Apps Script 裡的這份，不要改 GitHub 上的）
  SHEET_ID: '',                        // 留空 = 使用這份試算表（綁定在試算表上的腳本）
  FOLDER_NAME: '外掃檢查照片',          // 雲端硬碟中存放照片與學生名單的資料夾
  SHARE_PHOTOS: true,                  // 照片設為「知道連結的人可檢視」，點連結才能直接看
  TIMEZONE: 'Asia/Taipei',
  BUTTON_IMAGE: 'https://autoanima.github.io/outdoor-cleaning-map/assets/sum-button.png',
};

const SHEET_RECORDS = '檢查紀錄';
const HEAD_RECORDS = ['日期', '處所', '負責同學', '說明', '照片', '檢查人', '紀錄編號'];
const COL_PHOTO = 5, COL_KEY = 7;
const SHEET_SCORE = '扣分統計';
const SCORE_START_ROW = 10;
const SHEET_ROSTER = '工作分配';
const HEAD_ROSTER = ['代號', '工作內容', '負責人1', '負責人2'];

function doGet() {
  return json({ ok: true, msg: '外掃區檢查 API 運作中' });
}

function doPost(e) {
  try {
    const req = JSON.parse(e.postData.contents);
    if (String(req.token) !== String(CONFIG.TOKEN)) return json({ ok: false, error: '密碼錯誤', code: 'token' });
    switch (req.action) {
      case 'ping': return json(ping());
      case 'getRoster': return json({ ok: true, roster: getRoster() });
      case 'saveRoster': return json(saveRoster(req.roster || {}));
      case 'getStudents': return json(getStudents());
      case 'saveRecords': return json(saveRecords(req.rows || []));
      case 'uploadPhoto': return json(uploadPhoto(req));
      default: return json({ ok: false, error: '未知的動作：' + req.action });
    }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

/** 第一次使用（或更新程式後）手動執行一次：建立工作表、扣分統計與按鈕 */
function setup() {
  getRecordsSheet();
  getSheet(SHEET_ROSTER, HEAD_ROSTER);
  ensureScoreSheet(true);
  const folder = getRootFolder();
  Logger.log('完成！照片資料夾：' + folder.getUrl());
}

/** 試算表選單：外掃檢查 → 計算扣分 */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('外掃檢查').addItem('計算扣分', 'computeScores').addToUi();
}

/** 手機上的 Google 試算表 App 按不到圖片按鈕，所以也可以勾選「扣分統計」B6 的方塊來計算 */
function onEdit(e) {
  const r = e && e.range;
  if (!r || r.getSheet().getName() !== SHEET_SCORE || r.getA1Notation() !== 'B6') return;
  if (r.getValue() === true) computeScores();
}

function ping() {
  const ss = getSS();
  return { ok: true, sheetName: ss.getName(), sheetUrl: ss.getUrl() };
}

// ── 人員分配：存在「工作分配」工作表（也可以直接在試算表裡改）──
function getRoster() {
  const sh = getSS().getSheetByName(SHEET_ROSTER);
  const roster = { jobs: {}, inspectors: {} };
  if (!sh || sh.getLastRow() < 2) return roster;
  sh.getRange(2, 1, sh.getLastRow() - 1, 4).getDisplayValues().forEach(r => {
    const id = String(r[0]).trim();
    const names = [r[2], r[3]].map(s => String(s).trim()).filter(Boolean);
    if (!id) return;
    if (/^I\d+$/.test(id)) roster.inspectors[id] = names[0] || '';
    else roster.jobs[id] = names;
  });
  return roster;
}

function saveRoster(r) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = getSheet(SHEET_ROSTER, HEAD_ROSTER);
    const labels = r.labels || {};
    const rows = [];
    Object.keys(r.inspectors || {}).forEach(id => rows.push([id, labels[id] || '檢查人', r.inspectors[id] || '', '']));
    Object.keys(r.jobs || {}).forEach(id => {
      const n = r.jobs[id] || [];
      rows.push([id, labels[id] || '', n[0] || '', n[1] || '']);
    });
    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, HEAD_ROSTER.length).clearContent();
    if (rows.length) sh.getRange(2, 1, rows.length, HEAD_ROSTER.length).setValues(rows);
    return { ok: true, roster: getRoster() };
  } finally {
    lock.releaseLock();
  }
}

/** 從「外掃檢查照片」資料夾裡的名單試算表讀取學生（需有「姓名」欄，可有「科別」「座號」） */
function getStudents() {
  const folder = getRootFolder();
  const files = [];
  const it = folder.getFilesByType(MimeType.GOOGLE_SHEETS);
  while (it.hasNext()) files.push(it.next());
  if (!files.length) throw new Error('「' + CONFIG.FOLDER_NAME + '」資料夾裡找不到名單試算表');
  files.sort((a, b) => (/名單/.test(b.getName()) ? 1 : 0) - (/名單/.test(a.getName()) ? 1 : 0));
  const file = files[0];
  const values = SpreadsheetApp.openById(file.getId()).getSheets()[0].getDataRange().getDisplayValues();
  const h = values.findIndex(r => r.some(c => String(c).trim() === '姓名'));
  if (h < 0) throw new Error('名單「' + file.getName() + '」裡找不到「姓名」欄');
  const head = values[h].map(c => String(c).trim());
  const cDept = head.indexOf('科別'), cNo = head.indexOf('座號'), cName = head.indexOf('姓名');
  const students = [];
  values.slice(h + 1).forEach(r => {
    const name = String(r[cName] || '').trim();
    if (!name) return;
    const dept = cDept >= 0 ? String(r[cDept]).trim() : '';
    let no = cNo >= 0 ? String(r[cNo]).trim() : '';
    if (/^\d$/.test(no)) no = '0' + no;
    students.push(dept + no + name);
  });
  return { ok: true, source: file.getName(), students: students };
}

// ── 檢查紀錄：只保留「不好」；改成其他狀態時會自動刪掉那一列 ──
function saveRecords(rows) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = getRecordsSheet();
    const last = sh.getLastRow();
    const keys = last > 1 ? sh.getRange(2, COL_KEY, last - 1, 1).getValues().map(r => String(r[0])) : [];
    const index = new Map(keys.map((k, i) => [k, i + 2]));
    const updates = [], deletes = [], appends = new Map();
    rows.forEach(r => {
      const row = index.get(r.key);
      if (r.status !== '不好') {
        if (row) deletes.push(row);
        appends.delete(r.key);
        return;
      }
      const note = (r.issue ? '【有狀況】' : '') + (r.note || '');
      const vals = [toDate(r.date), r.item, r.owner, note, '', r.inspector || '', r.key];
      if (row) updates.push({ row: row, vals: vals, photos: r.photos });
      else appends.set(r.key, { vals: vals, photos: r.photos });
    });
    updates.forEach(u => {
      sh.getRange(u.row, 1, 1, u.vals.length).setValues([u.vals]);
      sh.getRange(u.row, COL_PHOTO).setRichTextValue(photoLinks(u.photos));
    });
    if (deletes.length) {
      if (sh.getMaxRows() - deletes.length < 2) sh.insertRowsAfter(sh.getMaxRows(), deletes.length);
      deletes.sort((a, b) => b - a).forEach(r => sh.deleteRow(r));
    }
    if (appends.size) {
      const list = Array.from(appends.values());
      const start = sh.getLastRow() + 1;
      sh.getRange(start, 1, list.length, HEAD_RECORDS.length).setValues(list.map(x => x.vals));
      list.forEach((x, i) => sh.getRange(start + i, COL_PHOTO).setRichTextValue(photoLinks(x.photos)));
      sh.getRange(start, 1, list.length, 1).setNumberFormat('yyyy/mm/dd');
    }
    return { ok: true, saved: rows.length };
  } finally {
    lock.releaseLock();
  }
}

/** 把多個照片網址變成可點的「照片1、照片2…」（同一格、分行） */
function photoLinks(urls) {
  const list = String(urls || '').split('\n').map(s => s.trim()).filter(Boolean);
  const b = SpreadsheetApp.newRichTextValue().setText(list.map((_, i) => '照片' + (i + 1)).join('\n'));
  let pos = 0;
  list.forEach((u, i) => {
    const t = '照片' + (i + 1);
    b.setLinkUrl(pos, pos + t.length, u);
    pos += t.length + 1;
  });
  return b.build();
}

function uploadPhoto(req) {
  if (!req.data) throw new Error('沒有照片資料');
  const folder = getDayFolder(req.date);
  const blob = Utilities.newBlob(Utilities.base64Decode(req.data), req.mimeType || 'image/jpeg', req.filename || 'photo.jpg');
  const file = folder.createFile(blob);
  if (req.description) file.setDescription(req.description);
  if (CONFIG.SHARE_PHOTOS) {
    try { file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW); } catch (e) { /* 學校帳號可能禁止公開分享 */ }
  }
  return { ok: true, id: file.getId(), url: file.getUrl() };
}

// ── 扣分統計 ──
function ensureScoreSheet(withButton) {
  const ss = getSS();
  let sh = ss.getSheetByName(SHEET_SCORE);
  const isNew = !sh;
  if (isNew) sh = ss.insertSheet(SHEET_SCORE, 0);
  if (isNew) {
    sh.getRange('A1').setValue('扣分統計').setFontSize(16).setFontWeight('bold');
    sh.getRange('A2').setValue('依「檢查紀錄」加總每位同學「不好」的次數。按右邊的按鈕，或勾選 B6，就會重新計算。').setFontColor('#6b7079');
    sh.getRange('A3:C3').setValues([['每次「不好」扣', 1, '分']]);
    sh.getRange('A4:C4').setValues([['起始日期', '', '（空白＝不限）']]);
    sh.getRange('A5:C5').setValues([['結束日期', '', '（空白＝不限）']]);
    sh.getRange('B4:B5').setNumberFormat('yyyy/mm/dd');
    sh.getRange('A6').setValue('勾選即計算');
    sh.getRange('B6').insertCheckboxes();
    sh.getRange('A7').setValue('最後計算時間');
    sh.getRange('A3:A7').setFontWeight('bold');
    sh.getRange('B3:B6').setBackground('#fff8db');
    sh.getRange(SCORE_START_ROW - 1, 1, 1, 4).setValues([['同學', '不好次數', '扣分', '不好的日期與處所']])
      .setFontWeight('bold').setBackground('#ede7fb');
    sh.setFrozenRows(SCORE_START_ROW - 1);
    sh.setColumnWidth(1, 150); sh.setColumnWidth(4, 420);
  }
  if (withButton && !sh.getImages().length) {
    try {
      sh.insertImage(CONFIG.BUTTON_IMAGE, 4, 3).setWidth(180).setHeight(48).assignScript('computeScores');
    } catch (e) { Logger.log('按鈕圖片建立失敗，可改用選單「外掃檢查 → 計算扣分」：' + e); }
  }
  return sh;
}

function computeScores() {
  const ss = getSS();
  const sh = ensureScoreSheet(false);
  const per = Number(sh.getRange('B3').getValue()) || 1;
  const from = sh.getRange('B4').getValue(), to = sh.getRange('B5').getValue();
  const fromT = from instanceof Date ? new Date(from.getFullYear(), from.getMonth(), from.getDate()).getTime() : -Infinity;
  const toT = to instanceof Date ? new Date(to.getFullYear(), to.getMonth(), to.getDate(), 23, 59, 59).getTime() : Infinity;

  const rec = getRecordsSheet();
  const last = rec.getLastRow();
  const data = last > 1 ? rec.getRange(2, 1, last - 1, 3).getValues() : [];
  const seen = {}, stats = {};
  data.forEach(r => {
    const d = r[0] instanceof Date ? r[0] : new Date(r[0]);
    const place = String(r[1]), who = String(r[2]).trim();
    if (!who || isNaN(d)) return;
    const t = d.getTime();
    if (t < fromT || t > toT) return;
    // 同一天、同一處、同一人只算一次（避免導師與檢查人重複記錄）
    const k = Utilities.formatDate(d, CONFIG.TIMEZONE, 'yyyyMMdd') + '|' + place + '|' + who;
    if (seen[k]) return;
    seen[k] = true;
    const s = stats[who] || (stats[who] = { n: 0, list: [] });
    s.n++;
    s.list.push({ t: t, text: Utilities.formatDate(d, CONFIG.TIMEZONE, 'M/d') + ' ' + place });
  });
  const rows = Object.keys(stats)
    .sort((a, b) => stats[b].n - stats[a].n || a.localeCompare(b))
    .map(who => {
      const s = stats[who];
      const detail = s.list.sort((a, b) => a.t - b.t).map(x => x.text).join('、');
      return [who, s.n, s.n * per, detail];
    });

  const lr = sh.getLastRow();
  if (lr >= SCORE_START_ROW) sh.getRange(SCORE_START_ROW, 1, lr - SCORE_START_ROW + 1, 5).clearContent();
  if (rows.length) {
    sh.getRange(SCORE_START_ROW, 1, rows.length, 4).setValues(rows).setVerticalAlignment('top');
    sh.getRange(SCORE_START_ROW, 4, rows.length, 1).setWrap(true);
  } else {
    sh.getRange(SCORE_START_ROW, 1).setValue('（這段期間沒有「不好」的紀錄）');
  }
  sh.getRange('B7').setValue(new Date()).setNumberFormat('yyyy/mm/dd hh:mm');
  sh.getRange('B6').setValue(false);
  try { ss.toast('已完成扣分加總，共 ' + rows.length + ' 位同學', '外掃檢查', 4); } catch (e) { /* 從網頁呼叫時沒有畫面 */ }
}

// ── helpers ──
function getSS() {
  return CONFIG.SHEET_ID ? SpreadsheetApp.openById(CONFIG.SHEET_ID) : SpreadsheetApp.getActiveSpreadsheet();
}

function getSheet(name, head) {
  const ss = getSS();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, head.length).setValues([head]).setFontWeight('bold').setBackground('#ede7fb');
    sh.setFrozenRows(1);
  }
  return sh;
}

/** 「檢查紀錄」若還是舊版格式，改名保留，再建立新的 */
function getRecordsSheet() {
  const ss = getSS();
  let sh = ss.getSheetByName(SHEET_RECORDS);
  if (sh && String(sh.getRange(1, 1).getValue()) !== HEAD_RECORDS[0]) {
    sh.setName(SHEET_RECORDS + '（舊版）' + Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'MMdd-HHmm'));
    sh = null;
  }
  if (!sh) {
    sh = getSheet(SHEET_RECORDS, HEAD_RECORDS);
    sh.hideColumns(COL_KEY);
    sh.setColumnWidth(2, 130); sh.setColumnWidth(3, 120); sh.setColumnWidth(4, 280);
  }
  return sh;
}

function toDate(s) {
  try { return Utilities.parseDate(String(s), CONFIG.TIMEZONE, 'yyyy/MM/dd'); } catch (e) { return new Date(); }
}

function getRootFolder() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* 資料夾被刪除，重新建立 */ }
  }
  const it = DriveApp.getFoldersByName(CONFIG.FOLDER_NAME);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(CONFIG.FOLDER_NAME);
  props.setProperty('FOLDER_ID', folder.getId());
  return folder;
}

function getDayFolder(dateStr) {
  const root = getRootFolder();
  const name = String(dateStr || Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy/MM/dd')).replace(/\//g, '-');
  const it = root.getFoldersByName(name);
  return it.hasNext() ? it.next() : root.createFolder(name);
}

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
