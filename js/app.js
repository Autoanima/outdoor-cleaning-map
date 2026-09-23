'use strict';
(() => {
  const D = window.MAP_DATA;
  const CFG = window.APP_CONFIG || {};
  const RESET_MS = (Number(CFG.resetHours) || 20) * 3600e3;
  const K = 1.5;          // 每 1 單位走廊長度 = 1.5px
  const PAD_T = 64, PAD_B = 70;
  const STATUSES = ['好', '不好', '未出席'];
  const ST_CLASS = { '好': 'good', '不好': 'bad', '未出席': 'absent' };
  const BADGE = { good: '✓', bad: '✕', absent: '缺', partial: '…' };
  const LS = { state: 'cleanmap.state.v2', settings: 'cleanmap.settings.v1', queue: 'cleanmap.queue.v1', roster: 'cleanmap.roster.v1' };

  const $ = (s, el = document) => el.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad2 = n => String(n).padStart(2, '0');
  const WEEK = '日一二三四五六';
  const fmtDate = d => `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
  const fmtDateW = d => `${fmtDate(d)}（${WEEK[d.getDay()]}）`;
  const fmtTime = d => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  const fmtStamp = d => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`;

  // ── 儲存 ──
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  };
  const idb = (() => {
    let dbp;
    const open = () => dbp ||= new Promise((res, rej) => {
      const r = indexedDB.open('cleanmap', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('photos');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const tx = async (mode, fn) => {
      const db = await open();
      return new Promise((res, rej) => {
        const t = db.transaction('photos', mode);
        const req = fn(t.objectStore('photos'));
        t.oncomplete = () => res(req && req.result);
        t.onerror = () => rej(t.error);
      });
    };
    return {
      put: (k, v) => tx('readwrite', s => s.put(v, k)),
      get: k => tx('readonly', s => s.get(k)),
      del: k => tx('readwrite', s => s.delete(k)),
      clear: () => tx('readwrite', s => s.clear()),
    };
  })();

  let settings = Object.assign({ gasUrl: '', token: '', inspector: '' }, store.get(LS.settings, {}));
  settings.gasUrl ||= CFG.gasUrl || '';
  const saveSettings = () => store.set(LS.settings, settings);
  // 人員分配（從雲端「工作分配」工作表讀取，手機上留一份快取）
  let roster = store.get(LS.roster, null);
  const emptyState = () => ({ sessionId: null, startedAt: null, records: {} });
  let state = Object.assign(emptyState(), store.get(LS.state, {}));
  let queue = store.get(LS.queue, []);

  function save() {
    if (!store.set(LS.state, state)) toast('手機儲存空間不足，請先同步後清空紀錄');
  }
  const rec = id => state.records[id] ||= { status: {}, issue: false, note: '', photos: [], updatedAt: 0 };
  function ensureSession() {
    if (state.startedAt) return;
    const now = new Date();
    state.startedAt = now.getTime();
    state.sessionId = 'S' + fmtStamp(now) + '-' + Math.random().toString(36).slice(2, 6);
  }

  // ── 物件名稱（同區同側同類有多個時自動編號）──
  const sectionById = Object.fromEntries(D.sections.map(s => [s.id, s]));
  const SIDE_NAME = { W: '西側', E: '東側', 'strip-W': '西側', 'strip-E': '東側', floor: '' };
  const itemById = {};
  (() => {
    const groups = {};
    D.items.forEach(it => {
      const sec = sectionById[it.section];
      if (it.type === 'floor') { it.from = sec.from; it.to = sec.to; it.chipAt ??= (sec.from + sec.to) / 2; }
      if (it.side.startsWith('strip')) { it.from = sec ? sec.from : 0; it.to = sec ? sec.to : D.length; }
      it.name = it.name || D.typeNames[it.type] || it.type;
      it.owners = [];
      (groups[it.type] ||= []).push(it);
      itemById[it.id] = it;
    });
    // 同一種物件由南到北編號：公佈欄玻璃 1、2、3…（同位置時東側在前）
    const sideRank = s => (s.endsWith('E') ? 0 : 1);
    Object.values(groups).forEach(arr => {
      arr.sort((a, b) => a.from - b.from || sideRank(a.side) - sideRank(b.side));
      arr.forEach((it, i) => {
        const sec = sectionById[it.section];
        it.no = arr.length > 1 ? i + 1 : '';
        it.title = it.no ? `${it.name} ${it.no}` : it.name;
        it.where = [sec?.label, SIDE_NAME[it.side]].filter(Boolean).join('・');
        it.full = it.title;
      });
    });
  })();
  const jobItems = id => D.items.filter(it => it.job === id);
  const jobTitle = id => jobItems(id).map(it => it.full).join('、');
  const inspectorName = slotId => roster?.inspectors?.[slotId] || '';
  // 班級存在「工作分配」的 CLASS 列（例如 商一甲）
  const className = () => roster?.jobs?.CLASS?.[0] || '';
  const withClass = name => (name && className() ? `${className()} ${name}` : name);
  const userOptions = () => [D.teacherLabel, ...D.inspectorSlots.map(s => withClass(inspectorName(s.id))).filter(Boolean)];
  // 檢查範圍：南區／北區檢查人只查自己區段內的物件（水泥平台也切成南北兩半）；導師全部
  const mySlot = () => D.inspectorSlots.find(s => inspectorName(s.id) && withClass(inspectorName(s.id)) === settings.inspector);
  const inScope = it => { const sec = mySlot()?.section; return !sec || !it.section || it.section === sec; };
  const scopeItems = () => D.items.filter(inScope);
  const scopeName = () => { const sec = mySlot()?.section; return sec ? sectionById[sec].label : ''; };

  function applyRoster(r) {
    const next = { jobs: r?.jobs || {}, inspectors: r?.inspectors || {} };
    const changed = JSON.stringify(next) !== JSON.stringify(roster);
    roster = next;
    store.set(LS.roster, roster);
    D.items.forEach(it => { it.owners = (roster.jobs[it.job] || []).filter(Boolean); });
    return changed;
  }

  function summary(item) {
    const r = state.records[item.id];
    if (!r) return { st: 'none', issue: false, photos: [] };
    const vals = item.owners.map(o => r.status[o]).filter(Boolean);
    let st = 'none';
    if (vals.length) {
      if (vals.includes('不好')) st = 'bad';
      else if (vals.includes('未出席')) st = 'absent';
      else if (vals.length === item.owners.length) st = 'good';
      else st = 'partial';
    }
    return { st, issue: !!r.issue, photos: r.photos || [] };
  }

  // ── 地圖 ──
  const y = u => PAD_T + u * K;
  const mapEl = $('#map');

  function buildMap() {
    const total = D.length;
    mapEl.style.height = (PAD_T + total * K + PAD_B) + 'px';
    let h = '';
    ['E', 'W'].forEach(s => {
      const sd = D.sides?.[s] || { name: SIDE_NAME[s] };
      h += `<div class="side-label side-${s}" style="top:4px">${esc(sd.name)}<small>${esc(sd.note || '')}</small></div>`;
    });
    h += `<div class="edge-label" style="top:${PAD_T - 24}px">▲ 南</div>`;
    h += `<div class="edge-label" style="top:${y(total) + 6}px">▼ 北</div>`;

    D.sections.forEach((sec, i) => {
      const floor = D.items.find(it => it.type === 'floor' && it.section === sec.id);
      const attrs = floor ? `data-id="${floor.id}" aria-label="${esc(floor.full)}"` : 'tabindex="-1"';
      h += `<button type="button" class="sec sec--${sec.color}" ${attrs} style="top:${y(sec.from)}px;height:${(sec.to - sec.from) * K}px">`;
      if (floor) h += `<span class="floor-chip" style="top:${(floor.chipAt - sec.from) * K}px">🧹 ${esc(floor.title)}<span class="badge"></span></span>`;
      h += `</button>`;
      if (i > 0) h += `<div class="sec-divider" style="top:${y(sec.from)}px"></div>`;
      const slot = D.inspectorSlots[i];
      const who = slot && inspectorName(slot.id);
      const sup = who ? `<span>檢查人<br>${className() ? esc(className()) + '<br>' : ''}${esc(who)}</span>` : '';
      h += `<div class="sec-tag ${sec.color}" style="top:${y(sec.from) + 8}px"><b>${esc(sec.label)}</b>${sup}</div>`;
    });
    D.landmarks.forEach(l => { h += `<div class="landmark side-${l.side}" style="top:${y(l.at)}px">${esc(l.name)}</div>`; });

    D.items.forEach(it => {
      const strip = it.side.startsWith('strip');
      if (it.type !== 'floor') {
        // 水泥平台在南北交界切開，中間留一點空隙
        const gapT = strip && it.from > 0 ? 3 : 0, gapB = strip && it.to < D.length ? 3 : 0;
        h += `<button type="button" class="obj obj--${it.type} side-${it.side}${it.double ? ' double' : ''}" data-id="${it.id}" aria-label="${esc(it.full)}" style="top:${y(it.from) + gapT}px;height:${(it.to - it.from) * K - gapT - gapB}px">`;
        if (strip) {
          // 長條平台上標兩次名稱
          [0.22, 0.75].forEach(f => { h += `<span class="obj-label" style="top:${f * 100}%">${esc(it.name + it.no)}</span>`; });
        } else {
          h += `<span class="obj-label">${esc(it.name + it.no)}</span>`;
        }
        h += `<span class="badge"></span></button>`;
      }
      let top;
      if (it.type === 'floor') top = y(it.chipAt) + 22;
      else if (strip) top = y(it.from + (it.side === 'strip-E' ? 50 : 105));
      else top = y((it.from + it.to) / 2);
      const side = strip ? it.side.slice(-1) : it.side;
      h += `<div class="annex annex-${side}" data-annex="${it.id}" style="top:${top}px"></div>`;
    });
    mapEl.innerHTML = h;
  }

  function refresh() {
    let checked = 0, issues = 0;
    D.items.forEach(it => {
      const s = summary(it);
      const mine = inScope(it);
      if (mine && (s.st === 'good' || s.st === 'bad' || s.st === 'absent')) checked++;
      if (mine && s.issue) issues++;
      const el = mapEl.querySelector(`[data-id="${it.id}"]`);
      if (el) {
        el.classList.toggle('out-scope', !mine);
        el.classList.remove('st-good', 'st-bad', 'st-absent', 'st-partial');
        if (s.st !== 'none') el.classList.add('st-' + s.st);
        el.classList.toggle('is-issue', s.issue);
        const b = el.querySelector('.badge');
        if (b) b.textContent = BADGE[s.st] || '';
      }
      const an = mapEl.querySelector(`[data-annex="${it.id}"]`);
      if (an) {
        let h = s.issue ? `<span class="flag" title="有狀況">!</span>` : '';
        const ph = s.photos, max = 2;
        ph.slice(0, max).forEach((p, i) => {
          const more = i === max - 1 && ph.length > max ? `<span class="more">+${ph.length - max + 1}</span>` : '';
          const busy = p.st === 'uploading' ? ' uploading' : '';
          h += `<button type="button" class="thumb${busy}" data-lb="${it.id}" data-i="${i}" aria-label="查看照片"><img src="${p.thumb}" alt="">${more}</button>`;
        });
        an.innerHTML = h;
      }
    });
    $('#progress').textContent = `${scopeName() ? scopeName() + ' ' : ''}已檢查 ${checked} / ${scopeItems().length}`;
    const chip = $('#issueChip');
    chip.hidden = !issues;
    chip.textContent = `⚠ ${issues} 處有狀況`;
    const d = state.startedAt ? new Date(state.startedAt) : new Date();
    $('#dateLabel').textContent = fmtDateW(d).slice(5);
    updateResetInfo();
  }

  function updateResetInfo() {
    const el = $('#resetInfo');
    if (!state.startedAt) { el.textContent = '尚未開始'; return; }
    const end = new Date(state.startedAt + RESET_MS);
    el.textContent = `${end.getMonth() + 1}/${end.getDate()} ${fmtTime(end)} 自動清空`;
  }

  mapEl.addEventListener('click', e => {
    const t = e.target.closest('.thumb');
    if (t) { openLightbox(t.dataset.lb, +t.dataset.i); return; }
    const o = e.target.closest('[data-id]');
    if (!o) return;
    if (!inScope(itemById[o.dataset.id])) return toast(`這裡不在你的檢查範圍（你負責${scopeName()}）`);
    openItem(o.dataset.id);
  });

  let issueCursor = -1;
  $('#issueChip').addEventListener('click', () => {
    const list = scopeItems().filter(it => summary(it).issue);
    if (!list.length) return;
    issueCursor = (issueCursor + 1) % list.length;
    const el = mapEl.querySelector(`[data-id="${list[issueCursor].id}"]`);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    setTimeout(() => el.classList.remove('flash'), 2000);
  });

  // ── 底部面板 ──
  const sheet = $('#sheet'), sheetBody = $('#sheetBody'), backdrop = $('#backdrop');
  let sheetMode = null; // { kind: 'item', id } | { kind: 'report' } | { kind: 'settings' }

  function openSheet(mode, html) {
    sheetMode = mode;
    sheetBody.innerHTML = html;
    sheet.hidden = false; backdrop.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeSheet() {
    if (sheetMode?.kind === 'item') commitNote();
    sheet.hidden = true; backdrop.hidden = true; sheetMode = null;
    document.body.style.overflow = '';
  }
  backdrop.addEventListener('click', closeSheet);
  const closeBtn = `<button type="button" class="close-btn" data-act="close" aria-label="關閉">✕</button>`;

  function itemHtml(item) {
    const r = state.records[item.id] || { status: {}, issue: false, note: '', photos: [] };
    let h = `<div class="sheet-head"><div><div class="eyebrow">${esc(item.where)}</div><h2 id="sheetTitle">${esc(item.title)}</h2></div>${closeBtn}</div>`;
    h += `<h3>清潔程度</h3><div class="owners">`;
    if (!item.owners.length) {
      h += `<p class="empty">尚未指定負責同學。請到 ⚙ 設定 →「人員設定」選擇。</p>`;
    }
    item.owners.forEach(o => {
      h += `<div class="owner-row"><div class="owner-name">${esc(o)}</div><div class="seg" role="group" aria-label="${esc(o)} 清潔程度">`;
      STATUSES.forEach(s => {
        h += `<button type="button" class="${ST_CLASS[s]}" data-act="status" data-owner="${esc(o)}" data-st="${s}" aria-pressed="${r.status[o] === s}">${s}</button>`;
      });
      h += `</div></div>`;
    });
    h += `</div>`;
    h += `<div class="issue-box${r.issue ? ' on' : ''}" id="issueBox">
      <label class="switch-row"><span class="switch"><input type="checkbox" id="issueToggle"${r.issue ? ' checked' : ''}><span></span></span>這裡有狀況</label>
      <textarea id="noteInput" placeholder="說明狀況，例如：玻璃破裂、排水孔堵塞、有垃圾未清…">${esc(r.note)}</textarea>
    </div>`;
    h += `<div class="photos-head"><h3>照片</h3><button type="button" class="btn btn--primary" data-act="photo">📷 拍照／上傳</button></div>`;
    if (r.photos.length) {
      h += `<div class="photo-grid">`;
      r.photos.forEach((p, i) => {
        let st = '';
        if (p.st === 'uploading') st = `<span class="st">上傳中…</span>`;
        else if (p.st === 'error') st = `<button type="button" class="st err" data-act="retry" data-pid="${p.id}">重試上傳</button>`;
        else if (p.st === 'local') st = `<span class="st">僅存手機</span>`;
        h += `<div class="photo-cell"><button type="button" class="open" data-act="view" data-i="${i}" aria-label="放大照片"><img src="${p.thumb}" alt=""></button>${st}<button type="button" class="del" data-act="delphoto" data-pid="${p.id}" aria-label="移除照片">✕</button></div>`;
      });
      h += `</div>`;
    } else {
      h += `<p class="empty">尚無照片。${settings.gasUrl ? '照片會壓縮後上傳到你的 Google 雲端硬碟。' : '尚未設定雲端，照片只會存在這支手機。'}</p>`;
    }
    return h;
  }

  function openItem(id) {
    const item = itemById[id];
    if (!item) return;
    openSheet({ kind: 'item', id }, itemHtml(item));
  }
  function rerenderItem(id) {
    if (sheetMode?.kind !== 'item' || sheetMode.id !== id) return;
    const scroll = sheetBody.scrollTop;
    const note = $('#noteInput')?.value;
    sheetBody.innerHTML = itemHtml(itemById[id]);
    if (note != null) $('#noteInput').value = note;
    sheetBody.scrollTop = scroll;
  }

  function touch(item) {
    const r = rec(item.id);
    r.updatedAt = Date.now();
    save();
    enqueue(rowsFor(item));
    refresh();
  }

  let noteTimer;
  function commitNote() {
    clearTimeout(noteTimer);
    const ta = $('#noteInput');
    if (!ta || sheetMode?.kind !== 'item') return;
    const item = itemById[sheetMode.id];
    const cur = state.records[item.id]?.note || '';
    if (ta.value === cur) return;
    ensureSession();
    rec(item.id).note = ta.value;
    touch(item);
  }

  sheetBody.addEventListener('input', e => {
    if (e.target.id === 'noteInput') { clearTimeout(noteTimer); noteTimer = setTimeout(commitNote, 800); }
  });
  sheetBody.addEventListener('change', e => {
    if (e.target.id === 'issueToggle' && sheetMode?.kind === 'item') {
      const item = itemById[sheetMode.id];
      ensureSession();
      const r = rec(item.id);
      r.issue = e.target.checked;
      $('#issueBox').classList.toggle('on', r.issue);
      if (r.issue) setTimeout(() => $('#noteInput')?.focus(), 50);
      commitNote();
      touch(item);
    }
  });

  sheetBody.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'close') return closeSheet();
    if (sheetMode?.kind === 'item') {
      const item = itemById[sheetMode.id];
      if (act === 'status') {
        ensureSession();
        const r = rec(item.id);
        const o = b.dataset.owner;
        r.status[o] = r.status[o] === b.dataset.st ? '' : b.dataset.st;
        b.parentElement.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', r.status[o] === x.dataset.st));
        touch(item);
        // 只有一位負責人且標「好」時自動關閉，節省時間；「不好」通常還要拍照，所以不關
        if (item.owners.length === 1 && r.status[o] === '好' && !r.issue) setTimeout(() => { if (sheetMode?.id === item.id) closeSheet(); }, 350);
      } else if (act === 'photo') {
        fileTarget = item.id;
        $('#fileInput').click();
      } else if (act === 'view') {
        openLightbox(item.id, +b.dataset.i);
      } else if (act === 'retry') {
        uploadPhoto(item.id, b.dataset.pid);
      } else if (act === 'delphoto') {
        if (!confirm('要從這次紀錄中移除這張照片嗎？\n（已上傳到雲端硬碟的檔案會保留）')) return;
        const r = rec(item.id);
        r.photos = r.photos.filter(p => p.id !== b.dataset.pid);
        idb.del(b.dataset.pid).catch(() => {});
        touch(item);
        rerenderItem(item.id);
      }
    }
    if (sheetMode?.kind === 'report') reportAction(act, b);
    if (sheetMode?.kind === 'settings') settingsAction(act, b);
  });

  // ── 照片：壓縮、存手機、上傳雲端 ──
  let fileTarget = null;
  $('#fileInput').addEventListener('change', async e => {
    const files = [...e.target.files];
    e.target.value = '';
    if (!files.length || !fileTarget) return;
    const id = fileTarget;
    for (const f of files) await addPhoto(id, f);
  });

  async function loadImage(file) {
    if ('createImageBitmap' in window) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch { /* fall through */ }
    }
    return new Promise((res, rej) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => rej(new Error('無法讀取圖片'));
      img.src = URL.createObjectURL(file);
    });
  }
  function drawTo(img, max) {
    const w = img.width, h = img.height, s = Math.min(1, max / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * s); c.height = Math.round(h * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  }
  const toBlob = (c, q) => new Promise((res, rej) => c.toBlob(b => b ? res(b) : rej(new Error('壓縮失敗')), 'image/jpeg', q));
  const blobToBase64 = b => new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result).split(',')[1]);
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(b);
  });

  async function addPhoto(itemId, file) {
    const item = itemById[itemId];
    try {
      toast('照片壓縮中…');
      const img = await loadImage(file);
      const full = await toBlob(drawTo(img, 1600), 0.72);
      const thumb = drawTo(img, 200).toDataURL('image/jpeg', 0.6);
      img.close?.();
      const pid = 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      try { await idb.put(pid, full); } catch { /* 無 IndexedDB 時只保留小圖 */ }
      ensureSession();
      rec(itemId).photos.push({ id: pid, thumb, st: settings.gasUrl ? 'uploading' : 'local' });
      touch(item);
      rerenderItem(itemId);
      toast(`已壓縮為 ${Math.round(full.size / 1024)} KB`);
      if (settings.gasUrl) uploadPhoto(itemId, pid, full);
    } catch (err) {
      toast('照片處理失敗：' + err.message);
    }
  }

  const inflight = new Set();
  async function uploadPhoto(itemId, pid, blob) {
    const item = itemById[itemId];
    const find = () => state.records[itemId]?.photos.find(p => p.id === pid);
    let ph = find();
    if (!ph || inflight.has(pid) || !settings.gasUrl) return;
    inflight.add(pid);
    ph.st = 'uploading'; save(); refresh(); rerenderItem(itemId);
    try {
      blob ||= await idb.get(pid);
      if (!blob) throw new Error('手機上找不到原圖');
      const data = await blobToBase64(blob);
      const res = await api('uploadPhoto', {
        date: fmtDate(new Date(state.startedAt)),
        filename: `${fmtStamp(new Date())}_${item.full.replace(/\s+/g, '_')}_${pid.slice(-4)}.jpg`,
        description: `${item.full}｜${item.owners.join('、')}`,
        mimeType: 'image/jpeg', data,
      });
      ph = find();
      if (ph) { ph.st = 'done'; ph.driveId = res.id; ph.url = res.url; }
    } catch (err) {
      ph = find();
      if (ph) ph.st = 'error';
      toast('照片上傳失敗：' + err.message);
    } finally {
      inflight.delete(pid);
    }
    if (find()) touch(item);
    rerenderItem(itemId);
  }
  function retryPhotos() {
    if (!settings.gasUrl || !navigator.onLine) return;
    D.items.forEach(it => (state.records[it.id]?.photos || []).forEach(p => {
      if (p.st !== 'done') uploadPhoto(it.id, p.id);
    }));
  }

  // ── 全螢幕照片 ──
  const lb = { el: $('#lightbox'), img: $('#lbImg'), photos: [], i: 0, item: null, url: null };
  function openLightbox(itemId, i) {
    lb.item = itemById[itemId];
    lb.photos = state.records[itemId]?.photos || [];
    if (!lb.photos.length) return;
    lb.i = Math.max(0, Math.min(i, lb.photos.length - 1));
    lb.el.hidden = false;
    showLb();
  }
  async function showLb() {
    const p = lb.photos[lb.i], i = lb.i;
    lb.img.src = p.thumb;
    $('#lbCaption').textContent = `${lb.item.full}（${i + 1}/${lb.photos.length}）`;
    $('#lbPrev').hidden = $('#lbNext').hidden = lb.photos.length < 2;
    const dl = $('#lbDrive');
    dl.hidden = !p.url; if (p.url) dl.href = p.url;
    if (lb.url) { URL.revokeObjectURL(lb.url); lb.url = null; }
    let src = null;
    try { const b = await idb.get(p.id); if (b) src = lb.url = URL.createObjectURL(b); } catch { /* ignore */ }
    if (!src && p.driveId) src = `https://drive.google.com/thumbnail?id=${encodeURIComponent(p.driveId)}&sz=w2000`;
    if (src) {
      const im = new Image();
      im.onload = () => { if (lb.i === i && !lb.el.hidden) lb.img.src = src; };
      im.src = src;
    }
  }
  const lbStep = d => { lb.i = (lb.i + d + lb.photos.length) % lb.photos.length; showLb(); };
  function closeLb() { lb.el.hidden = true; if (lb.url) { URL.revokeObjectURL(lb.url); lb.url = null; } }
  $('#lbClose').addEventListener('click', closeLb);
  $('#lbPrev').addEventListener('click', e => { e.stopPropagation(); lbStep(-1); });
  $('#lbNext').addEventListener('click', e => { e.stopPropagation(); lbStep(1); });
  lb.el.addEventListener('click', e => { if (e.target === lb.el) closeLb(); });
  let tx0 = null;
  lb.el.addEventListener('touchstart', e => { tx0 = e.touches.length === 1 ? e.touches[0].clientX : null; }, { passive: true });
  lb.el.addEventListener('touchend', e => {
    if (tx0 == null || lb.photos.length < 2) return;
    const dx = e.changedTouches[0].clientX - tx0;
    if (Math.abs(dx) > 50) lbStep(dx < 0 ? 1 : -1);
    tx0 = null;
  });
  document.addEventListener('keydown', e => {
    if (!lb.el.hidden) {
      if (e.key === 'Escape') closeLb();
      if (e.key === 'ArrowLeft') lbStep(-1);
      if (e.key === 'ArrowRight') lbStep(1);
    } else if (!sheet.hidden && e.key === 'Escape') closeSheet();
  });

  // ── 雲端同步（Google Apps Script）──
  async function api(action, payload = {}) {
    if (!settings.gasUrl) throw new Error('尚未設定雲端網址');
    const res = await fetch(settings.gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // 避免 CORS 預檢
      body: JSON.stringify({ action, token: settings.token, ...payload }),
    });
    let j;
    try { j = await res.json(); } catch { throw new Error('雲端回應格式錯誤，請確認部署權限為「所有人」'); }
    if (!j.ok) throw new Error(j.error || '雲端處理失敗');
    return j;
  }

  function rowsFor(item) {
    const r = state.records[item.id];
    if (!r || !state.sessionId) return [];
    const photos = (r.photos || []).filter(p => p.url).map(p => p.url).join('\n');
    return item.owners.map(owner => ({
      key: `${state.sessionId}|${item.id}|${owner}`,
      session: state.sessionId,
      date: fmtDate(new Date(state.startedAt)),
      section: sectionById[item.section]?.label || SIDE_NAME[item.side] || '',
      item: item.full,
      owner,
      status: r.status[owner] || '',
      issue: !!r.issue,
      note: r.note || '',
      photos,
      inspector: settings.inspector || '',
      updatedAt: r.updatedAt,
    }));
  }

  function enqueue(rows) {
    rows.forEach(r => {
      const i = queue.findIndex(q => q.key === r.key);
      if (i >= 0) queue[i] = r; else queue.push(r);
    });
    store.set(LS.queue, queue);
    scheduleFlush();
    updateSync();
  }
  let flushTimer, flushing = false, syncError = null;
  function scheduleFlush(ms = 1500) { clearTimeout(flushTimer); flushTimer = setTimeout(flush, ms); }
  async function flush() {
    if (flushing || !queue.length || !settings.gasUrl || !navigator.onLine) { updateSync(); return; }
    flushing = true; updateSync();
    const batch = queue.slice(0, 60);
    try {
      await api('saveRecords', { rows: batch });
      const sent = new Map(batch.map(r => [r.key, r.updatedAt]));
      queue = queue.filter(q => sent.get(q.key) !== q.updatedAt);
      store.set(LS.queue, queue);
      syncError = null;
    } catch (err) {
      syncError = err.message;
    }
    flushing = false;
    updateSync();
    if (queue.length && !syncError) scheduleFlush(300);
  }
  function updateSync() {
    const dot = $('#syncDot');
    dot.className = 'sync-dot';
    if (!settings.gasUrl) return;
    if (flushing) dot.classList.add('busy');
    else if (syncError) dot.classList.add('err');
    else if (queue.length) dot.classList.add('pending');
    else dot.classList.add('ok');
  }
  $('#syncBtn').addEventListener('click', () => {
    if (!settings.gasUrl) return toast('尚未設定雲端，紀錄只存在這支手機。請到 ⚙ 設定。');
    if (syncError) toast('同步失敗：' + syncError + '（重試中）');
    else if (queue.length) toast(`還有 ${queue.length} 筆等待寫入試算表…`);
    else toast('✓ 所有紀錄都已寫入試算表');
    flush(); retryPhotos();
  });
  window.addEventListener('online', () => { flush(); retryPhotos(); });

  // ── 每 20 小時自動清空 ──
  async function resetSession(auto) {
    flush();
    state = emptyState();
    save();
    try { await idb.clear(); } catch { /* ignore */ }
    closeSheet(); closeLb();
    refresh();
    toast(auto ? '已超過 20 小時，紀錄已清空，開始新一輪檢查' : '已清空本次紀錄');
  }
  function checkExpiry() {
    if (state.startedAt && Date.now() - state.startedAt >= RESET_MS) resetSession(true);
    else updateResetInfo();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { checkExpiry(); flush(); } });
  setInterval(() => { checkExpiry(); if (syncError || queue.length) flush(); }, 60e3);

  // ── 報表（指南針）──
  function buildReport() {
    const cnt = { '好': 0, '不好': 0, '未出席': 0 };
    const problems = new Map(); // owner → [{item, st}]
    const issues = [], unchecked = [];
    const items = scopeItems();
    items.forEach(it => {
      const r = state.records[it.id];
      const missing = [];
      it.owners.forEach(o => {
        const st = r?.status[o];
        if (!st) { missing.push(o); return; }
        cnt[st]++;
        if (st !== '好') {
          if (!problems.has(o)) problems.set(o, []);
          problems.get(o).push({ item: it, st });
        }
      });
      if (missing.length) unchecked.push({ item: it, missing });
      if (r?.issue) issues.push({ item: it, note: r.note, photos: (r.photos || []).filter(p => p.url).map(p => p.url) });
    });
    const checked = items.filter(it => ['good', 'bad', 'absent'].includes(summary(it).st)).length;
    const d = state.startedAt ? new Date(state.startedAt) : new Date();

    const L = [];
    L.push(`【外掃區檢查${scopeName() ? '・' + scopeName() : ''}】${fmtDateW(d)}`);
    L.push(`檢查 ${checked}/${items.length} 處｜好 ${cnt['好']}・不好 ${cnt['不好']}・未出席 ${cnt['未出席']}`);
    if (problems.size) {
      L.push('', '❌ 需要改進的同學：');
      problems.forEach((arr, o) => L.push(`・${o}：${arr.map(x => `${x.item.full}（${x.st}）`).join('、')}`));
    } else {
      L.push('', '✅ 今天大家都做得很好！');
    }
    if (issues.length) {
      L.push('', `⚠ 有狀況 ${issues.length} 處：`);
      issues.forEach(x => {
        L.push(`・${x.item.full}（${x.item.owners.join('、')}）${x.note ? '：' + x.note.replace(/\s+/g, ' ') : ''}`);
        x.photos.forEach(u => L.push(`  照片 ${u}`));
      });
    }
    if (settings.inspector) L.push('', `檢查人：${settings.inspector}`);
    return { d, total: items.length, cnt, problems, issues, unchecked, checked, message: L.join('\n') };
  }

  function openReport() {
    commitNote();
    const R = buildReport();
    let h = `<div class="sheet-head"><div><div class="eyebrow">${fmtDateW(R.d)}</div><h2 id="sheetTitle">檢查報表</h2></div>${closeBtn}</div>`;
    h += `<div class="tiles">
      <div class="tile good"><b>${R.cnt['好']}</b><span>好</span></div>
      <div class="tile bad"><b>${R.cnt['不好']}</b><span>不好</span></div>
      <div class="tile absent"><b>${R.cnt['未出席']}</b><span>未出席</span></div>
      <div class="tile issue"><b>${R.issues.length}</b><span>有狀況</span></div></div>`;
    h += `<p class="muted small" style="margin:4px 0 0">已檢查 ${R.checked} / ${R.total} 處</p>`;

    h += `<h3>需要改進的同學</h3>`;
    if (R.problems.size) {
      h += `<ul class="rlist">`;
      R.problems.forEach((arr, o) => {
        h += `<li><span class="who">${esc(o)}</span><div class="what">${arr.map(x =>
          `<button type="button" class="link-btn" data-act="goto" data-id="${x.item.id}">${esc(x.item.full)}</button><span class="tag ${ST_CLASS[x.st]}">${x.st}</span>`).join('<br>')}</div></li>`;
      });
      h += `</ul>`;
    } else h += `<p class="empty">沒有 👍</p>`;

    if (R.issues.length) {
      h += `<h3>有狀況的地方</h3><ul class="rlist">`;
      R.issues.forEach(x => {
        h += `<li><button type="button" class="link-btn" data-act="goto" data-id="${x.item.id}">${esc(x.item.full)}</button><span class="tag issue">!</span><div class="what">${esc(x.item.owners.join('、'))}${x.note ? '｜' + esc(x.note) : ''}</div></li>`;
      });
      h += `</ul>`;
    }
    h += `<h3>通知訊息（可修改）</h3><textarea id="msgText">${esc(R.message)}</textarea>`;
    h += `<div class="actions">
      <button type="button" class="btn btn--line wide" data-act="share">傳送 LINE 通知</button>
      <button type="button" class="btn wide" data-act="copy">📋 複製訊息</button>
    </div>
    <p id="saveStatus" class="muted small">按下「傳送 LINE 通知」時，會同時把「不好」的紀錄寫入 Google 試算表。</p>`;
    openSheet({ kind: 'report', R }, h);
    flush();
  }
  $('#compassBtn').addEventListener('click', openReport);

  async function copyText(t) {
    try { await navigator.clipboard.writeText(t); return true; } catch {
      const ta = document.createElement('textarea');
      ta.value = t; document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    }
  }

  async function reportAction(act, b) {
    const R = sheetMode.R;
    const msg = $('#msgText')?.value || R.message;
    if (act === 'goto') {
      closeSheet();
      const el = mapEl.querySelector(`[data-id="${b.dataset.id}"]`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => openItem(b.dataset.id), 450);
    } else if (act === 'share') {
      // 先開分享（必須在點擊當下呼叫），同時在背景寫入試算表
      const saving = saveReportToSheet(R, msg);
      if (navigator.share) {
        navigator.share({ text: msg }).catch(e => { if (e.name !== 'AbortError') toast('無法分享：' + e.message); });
      } else if (await copyText(msg)) toast('已複製，請貼到 LINE 群組');
      await saving;
    } else if (act === 'copy') {
      toast(await copyText(msg) ? '已複製訊息' : '複製失敗，請手動選取');
    }
  }

  async function saveReportToSheet(R, msg) {
    const st = $('#saveStatus');
    const say = t => { if (st) st.textContent = t; };
    if (!settings.gasUrl) { say('尚未設定雲端，沒有寫入試算表。'); return; }
    say('寫入 Google 試算表中…');
    {
      try {
        D.items.forEach(it => { if (state.records[it.id]) enqueue(rowsFor(it)); });
        clearTimeout(flushTimer);
        for (let n = 0; n < 20 && queue.length; n++) {
          if (flushing) { await new Promise(r => setTimeout(r, 300)); continue; }
          await flush();
          if (syncError) break;
        }
        if (queue.length) throw new Error(syncError || '仍有紀錄未寫入，請稍後再試');
        say('✓ 「不好」的紀錄都已寫入 Google 試算表');
      } catch (e) {
        say('✕ 寫入試算表失敗：' + e.message);
        toast('寫入試算表失敗：' + e.message);
      }
    }
  }

  // ── 設定 ──
  function openSettings() {
    let h = `<div class="sheet-head"><div><div class="eyebrow">使用人：${esc(settings.inspector || '未選擇')}</div><h2 id="sheetTitle">設定</h2></div>${closeBtn}</div>`;
    h += `<div class="actions"><button type="button" class="btn btn--primary wide" data-act="roster">👥 人員設定（掃地工作、檢查人）</button></div>`;
    h += `<div class="actions"><button type="button" class="btn wide" data-act="who">👤 切換使用人</button></div>`;
    h += `<h3>本次紀錄</h3><p class="muted small" style="margin:0">${state.startedAt
      ? `開始於 ${fmtDateW(new Date(state.startedAt))} ${fmtTime(new Date(state.startedAt))}，將於 ${Math.round(RESET_MS / 3600e3)} 小時後自動清空。`
      : '尚未開始。第一次標記時開始計時。'}<br>等待寫入試算表：${queue.length} 筆</p>`;
    h += `<div class="actions"><button type="button" class="btn btn--danger wide" data-act="reset">立即清空本次紀錄</button></div>`;
    h += `<h3>密碼鎖</h3><p class="muted small" style="margin:0">這支手機已記住密碼。借別人用或換手機時可以鎖定。</p>`;
    h += `<div class="actions"><button type="button" class="btn wide" data-act="lock">🔒 鎖定這支手機</button></div>`;
    h += `<details class="field"><summary class="muted small">進階：雲端網址</summary>
      <input type="url" id="setUrl" value="${esc(settings.gasUrl)}" autocomplete="off" style="margin-top:8px">
      <div class="actions"><button type="button" class="btn wide" data-act="ping">🔌 測試雲端連線</button></div>
      <p id="pingResult" class="muted small"></p></details>`;
    openSheet({ kind: 'settings' }, h);
  }
  $('#settingsBtn').addEventListener('click', openSettings);

  async function settingsAction(act) {
    if (act === 'ping') {
      settings.gasUrl = $('#setUrl').value.trim() || CFG.gasUrl || '';
      saveSettings();
      const out = $('#pingResult');
      out.textContent = '連線中…';
      try {
        const r = await api('ping');
        out.innerHTML = `✓ 連線成功：<a href="${esc(r.sheetUrl)}" target="_blank" rel="noopener">${esc(r.sheetName)}</a>`;
        flush(); retryPhotos();
      } catch (e) { out.textContent = '✕ ' + e.message; }
      updateSync();
    } else if (act === 'roster') {
      openRosterEditor();
    } else if (act === 'who') {
      openWho();
    } else if (act === 'lock') {
      settings.token = ''; settings.inspector = '';
      saveSettings();
      location.reload();
    } else if (act === 'reset') {
      const pendingPhotos = D.items.reduce((n, it) => n + (state.records[it.id]?.photos || []).filter(p => p.st !== 'done').length, 0);
      const warn = pendingPhotos ? `\n\n⚠ 還有 ${pendingPhotos} 張照片沒有上傳到雲端，清空後會遺失。` : '';
      if (confirm('確定要清空本次所有紀錄嗎？（已寫入試算表的資料不受影響）' + warn)) resetSession(false);
    }
  }

  // ── 切換使用人 ──
  const whoOptions = cur => userOptions().map(n => `<option value="${esc(n)}"${n === cur ? ' selected' : ''}>${esc(n)}</option>`).join('');
  function openWho() {
    let h = `<div class="sheet-head"><div><h2 id="sheetTitle">使用人是誰？</h2></div>${closeBtn}</div>`;
    h += `<select id="whoSheetSel" aria-label="使用人">${whoOptions(settings.inspector)}</select>`;
    h += `<div class="actions"><button type="button" class="btn btn--primary wide" data-act="whoOk">確定</button></div>`;
    openSheet({ kind: 'who' }, h);
  }
  function setUser(name) {
    settings.inspector = name;
    saveSettings();
    $('#userChip').textContent = '👤 ' + name;
    if (started) refresh();
  }
  $('#userChip').addEventListener('click', openWho);

  // ── 人員設定：下拉選單，已選的人會從其他選單中剔除 ──
  let students = [], rosterClass = '';
  const rosterHead = extra => `<div class="sheet-head"><div>${extra || ''}<h2 id="sheetTitle">人員設定</h2></div>${closeBtn}</div>`;
  // 學生名單存在手機上，打開人員設定時直接使用；背景再向雲端確認是否有更新
  // （Apps Script 久未使用時第一次回應可能要 10–30 秒）
  const LS_STUDENTS = 'cleanmap.students.v1';
  let studentList = store.get(LS_STUDENTS, null); // { source, students }
  let studentsLoading = null;
  function loadStudents() {
    return studentsLoading ||= api('getStudents').then(r => {
      const next = { source: r.source, className: r.className || '', students: r.students };
      const changed = JSON.stringify(next) !== JSON.stringify(studentList);
      studentList = next;
      store.set(LS_STUDENTS, studentList);
      return changed;
    }).finally(() => { studentsLoading = null; });
  }
  function useStudents() {
    students = studentList.students;
    rosterClass = studentList.className || String(studentList.source).replace(/名單.*$/, '').trim();
  }
  async function openRosterEditor() {
    if (studentList) {
      useStudents();
      renderRosterEditor();
      // 背景更新：名單有變才重畫選項（已選的不會被清掉）
      loadStudents().then(changed => {
        if (!changed || sheetMode?.kind !== 'roster') return;
        useStudents();
        renderRosterOptions();
        const eb = sheetBody.querySelector('.eyebrow');
        if (eb) eb.textContent = `名單來源：${studentList.source}（${students.length} 人）`;
        toast('學生名單已更新');
      }).catch(() => { /* 用手機上的名單即可 */ });
      return;
    }
    openSheet({ kind: 'roster' }, rosterHead() + `<p class="muted">第一次讀取雲端硬碟裡的學生名單中…<br>Google 雲端久未使用時需要 10–30 秒，請稍候。之後就會很快。</p>`);
    try {
      await loadStudents();
    } catch (e) {
      if (sheetMode?.kind === 'roster') sheetBody.innerHTML = rosterHead() + `<p class="lock-msg">無法讀取名單：${esc(e.message)}</p>`;
      return;
    }
    if (sheetMode?.kind !== 'roster') return;
    useStudents();
    renderRosterEditor();
  }
  function renderRosterEditor() {
    const source = studentList.source;
    if (sheetMode?.kind !== 'roster') openSheet({ kind: 'roster' }, '');
    const sel = (key, val) => `<select data-rs="${key}" data-val="${esc(val || '')}" aria-label="選擇同學"></select>`;
    let h = rosterHead(`<div class="eyebrow">名單來源：${esc(source)}（${students.length} 人）</div>`);
    h += `<p class="muted small" style="margin:0">每選一位同學，他就會從其他選單中移除。</p>`;
    h += `<h3>檢查人</h3>`;
    h += `<div class="rs-row"><div class="rs-label">${esc(D.teacherLabel)}</div><div class="muted small">固定</div></div>`;
    D.inspectorSlots.forEach(s => {
      h += `<div class="rs-row"><div class="rs-label">${esc(s.label)}${rosterClass ? `（${esc(rosterClass)}）` : ''}</div><div class="rs-selects">${sel(s.id, inspectorName(s.id))}</div></div>`;
    });
    h += `<h3>掃地工作</h3>`;
    D.jobs.forEach(j => {
      const cur = roster?.jobs?.[j.id] || [];
      h += `<div class="rs-row"><div class="rs-label">${esc(jobTitle(j.id))}</div><div class="rs-selects${j.slots > 1 ? ' two' : ''}">`;
      for (let i = 0; i < j.slots; i++) h += sel(`${j.id}:${i}`, cur[i]);
      h += `</div></div>`;
    });
    h += `<div class="save-bar"><button type="button" class="btn btn--primary" data-act="rosterSave">儲存到雲端</button></div>`;
    sheetBody.innerHTML = h;
    renderRosterOptions();
  }
  function renderRosterOptions() {
    const sels = [...sheetBody.querySelectorAll('select[data-rs]')];
    const taken = new Set(sels.map(s => s.dataset.val).filter(Boolean));
    sels.forEach(s => {
      const own = s.dataset.val;
      let o = `<option value="">— 請選擇 —</option>`;
      if (own && !students.includes(own)) o += `<option value="${esc(own)}" selected>${esc(own)}（不在名單中）</option>`;
      students.forEach(n => {
        if (taken.has(n) && n !== own) return;
        o += `<option value="${esc(n)}"${n === own ? ' selected' : ''}>${esc(n)}</option>`;
      });
      s.innerHTML = o;
    });
  }
  sheetBody.addEventListener('change', e => {
    const s = e.target.closest('select[data-rs]');
    if (!s || sheetMode?.kind !== 'roster') return;
    s.dataset.val = s.value;
    renderRosterOptions();
  });
  async function saveRosterFromEditor(b) {
    const r = { jobs: {}, inspectors: {}, labels: {} };
    D.inspectorSlots.forEach(s => { r.labels[s.id] = s.label; r.inspectors[s.id] = ''; });
    D.jobs.forEach(j => { r.labels[j.id] = jobTitle(j.id); r.jobs[j.id] = Array(j.slots).fill(''); });
    r.labels.CLASS = '班級';
    r.jobs.CLASS = [rosterClass || className()];
    const sels = [...sheetBody.querySelectorAll('select[data-rs]')];
    sels.forEach(s => {
      const [id, i] = s.dataset.rs.split(':');
      if (i == null) r.inspectors[id] = s.value;
      else r.jobs[id][+i] = s.value;
    });
    const empty = sels.filter(s => !s.value).length;
    if (empty && !confirm(`還有 ${empty} 個空位沒有選人，確定要儲存嗎？`)) return;
    b.disabled = true; b.textContent = '儲存中…';
    try {
      const res = await api('saveRoster', { roster: r });
      applyRoster(res.roster);
      buildMap(); refresh();
      ensureUserValid();
      toast('✓ 人員設定已儲存');
      closeSheet();
    } catch (e) {
      toast('儲存失敗：' + e.message);
      b.disabled = false; b.textContent = '儲存到雲端';
    }
  }
  sheetBody.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    if (sheetMode?.kind === 'roster' && b.dataset.act === 'rosterSave') saveRosterFromEditor(b);
    if (sheetMode?.kind === 'who' && b.dataset.act === 'whoOk') {
      setUser($('#whoSheetSel').value);
      closeSheet();
      toast('使用人：' + settings.inspector);
    }
  });

  // ── 自動更新：切回 App 或每 10 分鐘檢查 GitHub 上的檔案有沒有變，有就重新載入 ──
  // （從主畫面開啟的 App 常常只是從背景叫回，不會重新載入，所以要自己檢查）
  const WATCH = ['index.html', 'config.js', 'js/map-data.js', 'js/app.js', 'css/style.css'];
  async function fingerprint() {
    try {
      const tags = await Promise.all(WATCH.map(async u => {
        const r = await fetch(u, { method: 'HEAD', cache: 'no-store' });
        if (!r.ok) throw new Error(r.status);
        return r.headers.get('etag') || r.headers.get('last-modified') || '';
      }));
      return tags.join('|');
    } catch { return null; }
  }
  let fp0 = null, lastCheck = 0;
  fingerprint().then(f => { fp0 = f; lastCheck = Date.now(); });
  async function checkUpdate() {
    if (!fp0 || !navigator.onLine || Date.now() - lastCheck < 30e3) return;
    lastCheck = Date.now();
    const f = await fingerprint();
    if (!f || f === fp0) return;
    // 正在填寫或看照片時先不打斷，下次再更新
    if (!sheet.hidden || !lb.el.hidden) return;
    commitNote();
    try { sessionStorage.setItem('cleanmap.updated', '1'); } catch { /* ignore */ }
    location.reload();
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkUpdate(); });
  window.addEventListener('pageshow', e => { if (e.persisted) checkUpdate(); });
  setInterval(() => { if (!document.hidden && Date.now() - lastCheck > 10 * 60e3) checkUpdate(); }, 60e3);
  try {
    if (sessionStorage.getItem('cleanmap.updated')) {
      sessionStorage.removeItem('cleanmap.updated');
      setTimeout(() => toast('✓ 已更新到最新版本'), 800);
    }
  } catch { /* ignore */ }

  // ── 人員設定同步：任何一人按「儲存到雲端」後，其他手機切回 App 或每 2 分鐘自動更新 ──
  let rosterSyncing = false, lastRosterSync = 0;
  async function syncRoster(announce) {
    if (rosterSyncing || !settings.token || !navigator.onLine) return;
    rosterSyncing = true; lastRosterSync = Date.now();
    try {
      if (applyRoster(await fetchRoster(settings.token))) {
        buildMap(); refresh();
        if (sheetMode?.kind === 'item') rerenderItem(sheetMode.id);
        if (announce) toast('人員設定已更新');
        ensureUserValid();
      }
    } catch (err) {
      if (err.badToken) { settings.token = ''; saveSettings(); location.reload(); }
    } finally { rosterSyncing = false; }
  }
  // 若自己的名字被換掉，請重新選擇使用人
  function ensureUserValid() {
    if (started && !userOptions().includes(settings.inspector)) {
      toast('人員設定已變更，請重新選擇使用人');
      openWho();
    }
  }
  document.addEventListener('visibilitychange', () => { if (!document.hidden && started) syncRoster(true); });
  setInterval(() => { if (!document.hidden && started && Date.now() - lastRosterSync > 2 * 60e3) syncRoster(true); }, 30e3);

  // ── Toast ──
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ── 登入：密碼（= 雲端通關密碼）→ 選擇使用人 ──
  let started = false;
  function start() {
    document.body.classList.remove('locked');
    $('#userChip').textContent = '👤 ' + settings.inspector;
    buildMap();
    checkExpiry();
    refresh();
    updateSync();
    if (started) return;
    started = true;
    flush();
    retryPhotos();
    // 背景先把學生名單抓好，打開「人員設定」時就不用等
    setTimeout(() => loadStudents().catch(() => {}), 1500);
  }
  async function fetchRoster(token) {
    const res = await fetch(settings.gasUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'getRoster', token }),
    });
    const j = await res.json();
    if (!j.ok) {
      const bad = j.code === 'token' || /密碼錯誤/.test(j.error);
      const err = new Error(bad ? '密碼錯誤' : /未知的動作/.test(j.error) ? '雲端程式還是舊版，請重新部署 Code.gs' : j.error);
      err.badToken = bad;
      throw err;
    }
    return j.roster;
  }
  function showWhoStep() {
    $('#stepPw').hidden = true;
    $('#stepWho').hidden = false;
    $('#whoSel').innerHTML = whoOptions(settings.inspector);
    $('#lockBtn').textContent = '開始使用';
    $('#whoSel').focus();
  }
  function lockError(msg) {
    $('#lockMsg').textContent = msg;
    const card = $('.lock-card');
    card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
  }
  $('#lock').addEventListener('submit', async e => {
    e.preventDefault();
    $('#lockMsg').textContent = '';
    if (!$('#stepWho').hidden) {
      setUser($('#whoSel').value);
      start();
      return;
    }
    const pw = $('#lockPw').value.trim();
    if (!pw) return lockError('請輸入密碼');
    const btn = $('#lockBtn');
    btn.disabled = true; btn.textContent = '確認中…';
    const slow = setTimeout(() => { $('#lockMsg').textContent = ''; $('#lockMsg').insertAdjacentHTML('beforeend', '<span class="muted">Google 雲端啟動中，第一次可能需要 10–30 秒…</span>'); }, 4000);
    try {
      applyRoster(await fetchRoster(pw));
      settings.token = pw;
      saveSettings();
      showWhoStep();
    } catch (err) {
      clearTimeout(slow);
      lockError(err.badToken ? '密碼錯誤' : (err.message === 'Failed to fetch' ? '連不上網路，請確認網路後再試' : err.message));
      $('#lockPw').select();
      btn.textContent = '下一步';
    }
    clearTimeout(slow);
    if (!$('#stepWho').hidden) $('#lockMsg').textContent = '';
    btn.disabled = false;
  });

  (async () => {
    if (settings.token && settings.inspector && roster) {
      // 登入過：先用手機上的名單開啟，再到雲端更新
      applyRoster(roster);
      start();
      syncRoster();
      return;
    }
    $('#lockPw').focus();
  })();
})();
