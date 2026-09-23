/**
 * 外掃區檢查 — Google Apps Script 後端
 * ------------------------------------------------------------
 * 1. 在 Google 試算表中：擴充功能 → Apps Script，把這整份貼上。
 * 2. 修改下方 CONFIG（TOKEN 就是網頁的開啟密碼）。
 * 3. 執行一次 setup()（授權後會建立工作表與雲端資料夾）。
 * 4. 部署 → 新增部署作業 → 類型「網頁應用程式」
 *      執行身分：我　／　誰可以存取：所有人
 *    複製「網頁應用程式網址」（…/exec）貼到網站的 ⚙ 設定。
 * 修改程式後要「管理部署作業 → 編輯 → 版本：新版本」才會生效。
 */
const CONFIG = {
  TOKEN: '請改成你的密碼',              // 網頁的開啟密碼（只改你 Apps Script 裡的這份，不要改 GitHub 上的）
  SHEET_ID: '',                        // 留空 = 使用這份試算表（綁定在試算表上的腳本）
  FOLDER_NAME: '外掃檢查照片',          // 雲端硬碟中存放照片的資料夾
  SHARE_PHOTOS: true,                  // 照片設為「知道連結的人可檢視」，網頁才能顯示大圖
  NOTIFY_EMAILS: '',                   // 報表寄送對象，多個用逗號分隔，例如 'a@school.edu.tw,b@gmail.com'
  TIMEZONE: 'Asia/Taipei',
};

const SHEET_RECORDS = '檢查紀錄';
const HEAD_RECORDS = ['紀錄編號', '日期', '區域', '項目', '同學', '清潔程度', '狀況', '狀況說明', '照片', '檢查人', '更新時間'];
const SHEET_REPORTS = '每日彙整';
const HEAD_REPORTS = ['場次', '日期', '彙整時間', '已檢查', '總數', '好', '不好', '未出席', '有狀況', '需改進同學', '檢查人', '通知訊息'];
const SHEET_STATS = '個人統計';
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
      case 'saveReport': return json(saveReport(req.report || {}));
      case 'notify': return json(notify(req));
      default: return json({ ok: false, error: '未知的動作：' + req.action });
    }
  } catch (err) {
    return json({ ok: false, error: String(err && err.message || err) });
  }
}

/** 第一次使用時手動執行：建立工作表、統計表與照片資料夾 */
function setup() {
  getSheet(SHEET_RECORDS, HEAD_RECORDS);
  getSheet(SHEET_REPORTS, HEAD_REPORTS);
  getSheet(SHEET_ROSTER, HEAD_ROSTER);
  const ss = getSS();
  let st = ss.getSheetByName(SHEET_STATS);
  if (!st) {
    st = ss.insertSheet(SHEET_STATS);
    st.getRange('A1').setValue('依同學統計每種清潔程度的次數（自動更新，可作為加扣分依據）');
    st.getRange('A3').setFormula(
      "=IFERROR(QUERY('" + SHEET_RECORDS + "'!A:K,\"select E, count(A) where F is not null and F <> '' group by E pivot F\",1),\"尚無資料\")");
    st.setFrozenRows(3);
  }
  const folder = getRootFolder();
  Logger.log('完成！照片資料夾：' + folder.getUrl());
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

function saveRecords(rows) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = getSheet(SHEET_RECORDS, HEAD_RECORDS);
    const last = sh.getLastRow();
    const keys = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().map(r => String(r[0])) : [];
    const index = new Map(keys.map((k, i) => [k, i + 2]));
    const appends = [];
    rows.forEach(r => {
      const vals = [
        r.key, r.date, r.section, r.item, r.owner, r.status || '',
        r.issue ? '有狀況' : '', r.note || '', r.photos || '', r.inspector || '',
        r.updatedAt ? new Date(r.updatedAt) : new Date(),
      ];
      const row = index.get(r.key);
      if (row > 0) sh.getRange(row, 1, 1, vals.length).setValues([vals]);
      else if (row < 0) appends[-row - 1] = vals;       // 同一批重複的 key
      else { appends.push(vals); index.set(r.key, -appends.length); }
    });
    if (appends.length) {
      sh.getRange(sh.getLastRow() + 1, 1, appends.length, HEAD_RECORDS.length).setValues(appends);
    }
    return { ok: true, saved: rows.length };
  } finally {
    lock.releaseLock();
  }
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

function saveReport(r) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const sh = getSheet(SHEET_REPORTS, HEAD_REPORTS);
    const vals = [r.session, r.date, r.time, r.checked, r.total, r.good, r.bad, r.absent, r.issues, r.problems, r.inspector, r.message];
    const last = sh.getLastRow();
    const keys = last > 1 ? sh.getRange(2, 1, last - 1, 1).getValues().map(x => String(x[0])) : [];
    const i = keys.indexOf(String(r.session));
    if (i >= 0) sh.getRange(i + 2, 1, 1, vals.length).setValues([vals]);
    else sh.appendRow(vals);
    return { ok: true };
  } finally {
    lock.releaseLock();
  }
}

function notify(req) {
  const to = String(CONFIG.NOTIFY_EMAILS || '').trim();
  if (!to) throw new Error('Code.gs 的 NOTIFY_EMAILS 尚未設定收件者');
  MailApp.sendEmail({ to: to, subject: req.subject || '外掃區檢查', body: req.body || '' });
  return { ok: true, to: to };
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
