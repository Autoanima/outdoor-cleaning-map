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
  const LS = { state: 'cleanmap.state.v1', settings: 'cleanmap.settings.v1', queue: 'cleanmap.queue.v1' };

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

  let settings = Object.assign({ gasUrl: '', token: '', inspector: '' }, { gasUrl: CFG.gasUrl || '' }, store.get(LS.settings, {}));
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
  const SIDE_NAME = { W: '西側', E: '東側', 'out-W': '西側牆外', floor: '' };
  const itemById = {};
  (() => {
    const groups = {};
    D.items.forEach(it => {
      const sec = sectionById[it.section];
      if (it.type === 'floor') { it.from = sec.from; it.to = sec.to; it.chipAt ??= (sec.from + sec.to) / 2; }
      it.name = it.name || D.typeNames[it.type] || it.type;
      (groups[`${it.section}|${it.side}|${it.type}`] ||= []).push(it);
      itemById[it.id] = it;
    });
    Object.values(groups).forEach(arr => {
      arr.sort((a, b) => a.from - b.from);
      arr.forEach((it, i) => {
        const sec = sectionById[it.section];
        it.title = it.name + (arr.length > 1 ? ' ' + '①②③④⑤⑥⑦⑧⑨'[i] : '');
        it.where = sec.label + (SIDE_NAME[it.side] ? '・' + SIDE_NAME[it.side] : '');
        it.full = `${it.where} ${it.title}`;
      });
    });
  })();

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
    h += `<div class="side-label side-E" style="top:4px">東側<small>司令台側</small></div>`;
    h += `<div class="side-label side-W" style="top:4px">西側<small>警衛室側</small></div>`;
    h += `<div class="edge-label" style="top:${PAD_T - 24}px">▲ 南</div>`;
    h += `<div class="edge-label" style="top:${y(total) + 6}px">▼ 北</div>`;

    D.sections.forEach((sec, i) => {
      const floor = D.items.find(it => it.type === 'floor' && it.section === sec.id);
      const attrs = floor ? `data-id="${floor.id}" aria-label="${esc(floor.full)}"` : 'tabindex="-1"';
      h += `<button type="button" class="sec sec--${sec.color}" ${attrs} style="top:${y(sec.from)}px;height:${(sec.to - sec.from) * K}px">`;
      if (floor) h += `<span class="floor-chip" style="top:${(floor.chipAt - sec.from) * K}px">🧹 ${esc(floor.name)}<span class="badge"></span></span>`;
      h += `</button>`;
      if (i > 0) h += `<div class="sec-divider" style="top:${y(sec.from)}px"></div>`;
      const sup = sec.supervisor ? `<span>${esc(sec.supervisor).replace(' ', '<br>')}</span>` : '';
      h += `<div class="sec-tag ${sec.color}" style="top:${y(sec.from) + 8}px"><b>${esc(sec.label)}</b>${sup}</div>`;
    });
    h += `<div class="wall wall-E" style="top:${y(0)}px;height:${total * K}px"></div>`;
    h += `<div class="wall wall-W" style="top:${y(0)}px;height:${total * K}px"></div>`;
    D.landmarks.forEach(l => { h += `<div class="landmark side-${l.side}" style="top:${y(l.at)}px">${esc(l.name)}</div>`; });

    D.items.forEach(it => {
      if (it.type !== 'floor') {
        h += `<button type="button" class="obj obj--${it.type} side-${it.side}${it.double ? ' double' : ''}" data-id="${it.id}" aria-label="${esc(it.full)}" style="top:${y(it.from)}px;height:${(it.to - it.from) * K}px">`;
        if (it.type === 'platform') h += '平台';
        h += `<span class="badge"></span></button>`;
      }
      let top, cls = it.side;
      if (it.type === 'floor') top = y(it.chipAt) + 22;
      else if (it.side === 'out-W') top = y(it.to) + 6;
      else top = y((it.from + it.to) / 2);
      h += `<div class="annex annex-${cls}" data-annex="${it.id}" style="top:${top}px"></div>`;
    });
    mapEl.innerHTML = h;
  }

  function refresh() {
    let checked = 0, issues = 0;
    D.items.forEach(it => {
      const s = summary(it);
      if (s.st === 'good' || s.st === 'bad' || s.st === 'absent') checked++;
      if (s.issue) issues++;
      const el = mapEl.querySelector(`[data-id="${it.id}"]`);
      if (el) {
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
    $('#progress').textContent = `已檢查 ${checked} / ${D.items.length}`;
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
    if (o) openItem(o.dataset.id);
  });

  let issueCursor = -1;
  $('#issueChip').addEventListener('click', () => {
    const list = D.items.filter(it => summary(it).issue);
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
    if (e.target.dataset.set) {
      settings[e.target.dataset.set] = e.target.value.trim();
      store.set(LS.settings, settings);
      updateSync();
      if (e.target.dataset.set !== 'inspector') { scheduleFlush(300); retryPhotos(); }
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
      section: sectionById[item.section].label,
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
    D.items.forEach(it => {
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
    const checked = D.items.length - unchecked.length;
    const d = state.startedAt ? new Date(state.startedAt) : new Date();

    const L = [];
    L.push(`【外掃區檢查】${fmtDateW(d)}`);
    L.push(`檢查 ${checked}/${D.items.length} 處｜好 ${cnt['好']}・不好 ${cnt['不好']}・未出席 ${cnt['未出席']}`);
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
    if (unchecked.length) {
      L.push('', '（尚未檢查：' + unchecked.map(x => x.item.full).join('、') + '）');
    }
    const sups = D.sections.map(s => s.supervisor).filter(Boolean);
    if (sups.length) L.push('', '監督：' + sups.join('、'));
    return { d, cnt, problems, issues, unchecked, checked, message: L.join('\n') };
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
    h += `<p class="muted small" style="margin:4px 0 0">已檢查 ${R.checked} / ${D.items.length} 處</p>`;

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
    if (R.unchecked.length) {
      h += `<h3>尚未檢查</h3><ul class="rlist">`;
      R.unchecked.forEach(x => {
        h += `<li><button type="button" class="link-btn" data-act="goto" data-id="${x.item.id}">${esc(x.item.full)}</button><div class="what">${esc(x.missing.join('、'))}</div></li>`;
      });
      h += `</ul>`;
    }

    h += `<h3>通知訊息（可修改）</h3><textarea id="msgText">${esc(R.message)}</textarea>`;
    h += `<div class="actions">
      <button type="button" class="btn btn--primary wide" data-act="share">📤 傳送通知（LINE 等）</button>
      <button type="button" class="btn" data-act="copy">📋 複製訊息</button>
      <button type="button" class="btn" data-act="email"${settings.gasUrl ? '' : ' disabled'}>✉️ 寄 Email</button>
      <button type="button" class="btn wide" data-act="saveReport"${settings.gasUrl ? '' : ' disabled'}>📊 寫入 Google 試算表</button>
    </div>`;
    if (!settings.gasUrl) h += `<p class="muted small">尚未設定雲端，無法寫入試算表或寄信。請按右上角 ⚙ 設定。</p>`;
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
      if (navigator.share) {
        try { await navigator.share({ text: msg }); } catch (e) { if (e.name !== 'AbortError') toast('無法分享：' + e.message); }
      } else if (await copyText(msg)) toast('已複製，請貼到 LINE 群組');
    } else if (act === 'copy') {
      toast(await copyText(msg) ? '已複製訊息' : '複製失敗，請手動選取');
    } else if (act === 'email') {
      if (!confirm('要把這份報表寄到 Apps Script 裡設定的收件信箱嗎？')) return;
      b.disabled = true;
      try { const r = await api('notify', { subject: `外掃區檢查 ${fmtDateW(R.d)}`, body: msg }); toast(`已寄出給 ${r.to}`); }
      catch (e) { toast('寄信失敗：' + e.message); }
      b.disabled = false;
    } else if (act === 'saveReport') {
      b.disabled = true; b.textContent = '寫入中…';
      try {
        D.items.forEach(it => { if (state.records[it.id]) enqueue(rowsFor(it)); });
        clearTimeout(flushTimer);
        for (let n = 0; n < 20 && queue.length; n++) {
          if (flushing) { await new Promise(r => setTimeout(r, 300)); continue; }
          await flush();
          if (syncError) break;
        }
        if (queue.length) throw new Error(syncError || '仍有紀錄未寫入，請稍後再試');
        await api('saveReport', {
          report: {
            session: state.sessionId || 'S' + fmtStamp(R.d),
            date: fmtDate(R.d), time: fmtTime(new Date()),
            checked: R.checked, total: D.items.length,
            good: R.cnt['好'], bad: R.cnt['不好'], absent: R.cnt['未出席'], issues: R.issues.length,
            problems: [...R.problems.entries()].map(([o, arr]) => `${o}（${arr.map(x => x.st).join('、')}）`).join('、'),
            inspector: settings.inspector || '', message: msg,
          },
        });
        toast('✓ 已寫入 Google 試算表');
        b.textContent = '✓ 已寫入試算表';
      } catch (e) {
        toast('寫入失敗：' + e.message);
        b.textContent = '📊 寫入 Google 試算表';
      }
      b.disabled = false;
    }
  }

  // ── 設定 ──
  function openSettings() {
    let h = `<div class="sheet-head"><div><div class="eyebrow">只會存在這支手機</div><h2 id="sheetTitle">設定</h2></div>${closeBtn}</div>`;
    h += `<div class="field"><label for="setUrl">雲端網址（Apps Script /exec）</label>
      <input type="url" id="setUrl" data-set="gasUrl" value="${esc(settings.gasUrl)}" placeholder="https://script.google.com/macros/s/…/exec" autocomplete="off">
      <div class="hint">設定方式見 GitHub 上的 README。未設定時，紀錄與照片只存在這支手機。</div></div>`;
    h += `<div class="field"><label for="setToken">通關密碼</label>
      <input type="password" id="setToken" data-set="token" value="${esc(settings.token)}" autocomplete="off">
      <div class="hint">和 Code.gs 裡的 TOKEN 相同。</div></div>`;
    h += `<div class="field"><label for="setName">檢查人</label>
      <input type="text" id="setName" data-set="inspector" value="${esc(settings.inspector)}" placeholder="例如：王老師" autocomplete="off"></div>`;
    h += `<div class="actions"><button type="button" class="btn wide" data-act="ping">🔌 測試雲端連線</button></div>`;
    h += `<p id="pingResult" class="muted small"></p>`;
    h += `<h3>本次紀錄</h3><p class="muted small" style="margin:0">${state.startedAt
      ? `開始於 ${fmtDateW(new Date(state.startedAt))} ${fmtTime(new Date(state.startedAt))}，將於 ${Math.round(RESET_MS / 3600e3)} 小時後自動清空。`
      : '尚未開始。第一次標記時開始計時。'}<br>等待寫入試算表：${queue.length} 筆</p>`;
    h += `<div class="actions"><button type="button" class="btn btn--danger wide" data-act="reset">立即清空本次紀錄</button></div>`;
    h += `<h3>密碼鎖</h3><p class="muted small" style="margin:0">這支手機已記住密碼。借別人用或換手機時可以鎖定。</p>`;
    h += `<div class="actions"><button type="button" class="btn wide" data-act="lock">🔒 鎖定這支手機</button></div>`;
    openSheet({ kind: 'settings' }, h);
  }
  $('#settingsBtn').addEventListener('click', openSettings);

  async function settingsAction(act) {
    if (act === 'ping') {
      document.activeElement?.blur?.();
      ['setUrl', 'setToken', 'setName'].forEach(id => { const el = $('#' + id); settings[el.dataset.set] = el.value.trim(); });
      store.set(LS.settings, settings);
      const out = $('#pingResult');
      out.textContent = '連線中…';
      try {
        const r = await api('ping');
        out.innerHTML = `✓ 連線成功：<a href="${esc(r.sheetUrl)}" target="_blank" rel="noopener">${esc(r.sheetName)}</a>`;
        flush(); retryPhotos();
      } catch (e) { out.textContent = '✕ ' + e.message; }
      updateSync();
    } else if (act === 'lock') {
      try { localStorage.removeItem(LS_PW); } catch { /* ignore */ }
      location.reload();
    } else if (act === 'reset') {
      const pendingPhotos = D.items.reduce((n, it) => n + (state.records[it.id]?.photos || []).filter(p => p.st !== 'done').length, 0);
      const warn = pendingPhotos ? `\n\n⚠ 還有 ${pendingPhotos} 張照片沒有上傳到雲端，清空後會遺失。` : '';
      if (confirm('確定要清空本次所有紀錄嗎？（已寫入試算表的資料不受影響）' + warn)) resetSession(false);
    }
  }

  // ── Toast ──
  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
  }

  // ── 密碼鎖：解開加密名單後才啟動 ──
  const LS_PW = 'cleanmap.pw.v1';
  async function unlock(pw) {
    const roster = await window.RosterCrypto.decrypt(window.ROSTER_ENC, pw);
    D.items.forEach(it => { it.owners = roster.owners?.[it.id] || []; });
    D.sections.forEach(s => { s.supervisor = roster.supervisors?.[s.id] || ''; });
  }
  function start() {
    document.body.classList.remove('locked');
    buildMap();
    checkExpiry();
    refresh();
    updateSync();
    flush();
    retryPhotos();
  }
  $('#lock').addEventListener('submit', async e => {
    e.preventDefault();
    const pw = $('#lockPw').value;
    const msg = $('#lockMsg');
    msg.textContent = '';
    try {
      await unlock(pw);
      try { localStorage.setItem(LS_PW, pw); } catch { /* ignore */ }
      start();
    } catch {
      msg.textContent = '密碼錯誤';
      const card = $('.lock-card');
      card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
      $('#lockPw').select();
    }
  });
  (async () => {
    if (!window.ROSTER_ENC || !window.crypto?.subtle) {
      $('#lockMsg').textContent = !window.ROSTER_ENC ? '找不到名單檔 js/roster.enc.js' : '請用 https 網址開啟';
      return;
    }
    let saved = null;
    try { saved = localStorage.getItem(LS_PW); } catch { /* ignore */ }
    if (saved) {
      try { await unlock(saved); start(); return; }
      catch { try { localStorage.removeItem(LS_PW); } catch { /* ignore */ } }
    }
    $('#lockPw').focus();
  })();
})();
