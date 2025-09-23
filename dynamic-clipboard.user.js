// ==UserScript==
// @name         Dynamic Clipboard (CSV/TSV → fast copy)
// @namespace    https://your-org.example
// @version      1.3.4
// @description  Paste CSV or spreadsheet (TSV) once, then copy field-by-field with one click / hotkeys while you move through web forms. No storage by default; optional session keep. GDPR-friendly.
// @author       you
// @match        *://*/*
// @run-at       document-end
// @connect      none
// @updateURL   https://github.com/lwhitemyo/dynamic-clipboard/raw/refs/heads/main/dynamic-clipboard.user.js
// @downloadURL https://github.com/lwhitemyo/dynamic-clipboard/raw/refs/heads/main/dynamic-clipboard.user.js
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  // Use page context for window.name and navigation
  const page = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  if (page.__DC_CLIPBOARD_LOADED__) return; page.__DC_CLIPBOARD_LOADED__ = true;

  // ---------- STATE (IN-MEMORY ONLY by default) ----------
  let rows = [];        // array of objects (parsed data)
  let columns = [];     // header names
  let index = 0;        // current record
  let copyCycle = [];   // order + subset of columns to cycle through
  let cyclePtr = 0;     // pointer in copyCycle
  let hotkeysWorkInInputs = true; // default ON
  let activeDelimiter = ','; // inferred or chosen
  let keepOnReload = true;   // default ON (pre-ticked)
  let formURL = '';          // optional quick-return URL (persisted in session)

  // Remembered panel position (for clean minimize/restore)
  let lastLeft = null, lastTop = null;

  // ---------- SESSION KEEP (opt-in) ----------
  const MARK = '||DC='; // appended to window.name
  function saveSession() {
    if (!keepOnReload) return;
    try {
      const payload = {
        v: 2,                       // payload version
        delimiter: activeDelimiter,
        columns, rows, index, copyCycle,
        formURL,                    // persist form URL
        hotkeysWorkInInputs         // persist hotkey pref
      };
      const enc = encodeURIComponent(JSON.stringify(payload));
      const base = (page.name || '').split(MARK)[0] || '';
      page.name = base + MARK + enc;
    } catch {}
  }
  function loadSession() {
    try {
      const wn = page.name || '';
      const i = wn.indexOf(MARK);
      if (i === -1) return false;
      const enc = wn.slice(i + MARK.length);
      if (!enc) return false;
      const payload = JSON.parse(decodeURIComponent(enc));
      if (!payload || (payload.v !== 1 && payload.v !== 2)) return false;

      activeDelimiter = payload.delimiter || ',';
      columns = Array.isArray(payload.columns) ? payload.columns : [];
      rows = Array.isArray(payload.rows) ? payload.rows : [];
      index = Math.min(Math.max(0, payload.index|0), Math.max(0, rows.length-1));
      copyCycle = Array.isArray(payload.copyCycle) && payload.copyCycle.length ? payload.copyCycle : [...columns];

      // v2 fields (safe defaults for v1)
      formURL = typeof payload.formURL === 'string' ? payload.formURL : '';
      if (typeof payload.hotkeysWorkInInputs === 'boolean') {
        hotkeysWorkInInputs = payload.hotkeysWorkInInputs;
      }

      return rows.length > 0 || !!formURL;
    } catch { return false; }
  }

  // Attempt auto-restore on load (only populates if previous page set it)
  const restored = loadSession();

  // ---------- UTIL: DELIMITER DETECTION ----------
  function detectDelimiter(text) {
    const candidates = [',', '	', ';', '|'];
    const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
    if (!lines.length) return ',';
    const line = lines[0];
    let best = ',', bestCount = -1;
    candidates.forEach(d => {
      let count = 0, inQ = false;
      for (let i=0;i<line.length;i++) {
        const c = line[i];
        if (c === '"') { if (line[i+1] === '"') { i++; } else { inQ = !inQ; } continue; }
        if (!inQ && c === d) count++;
      }
      if (count > bestCount) { bestCount = count; best = d; }
    });
    return bestCount > 0 ? best : ',';
  }

  // ---------- UTIL: DSV PARSER (RFC4180-ish, delimiter aware) ----------
  function parseDSV(text, delimiter) {
    const rows = [];
    let i = 0, field = '', row = [], inQuotes = false;
    function pushField() { row.push(field); field = ''; }
    function pushRow() { rows.push(row); row = []; }
    while (i < text.length) {
      const c = text[i++];
      if (inQuotes) {
        if (c === '"') { if (text[i] === '"') { field += '"'; i++; } else { inQuotes = false; } }
        else { field += c; }
      } else {
        if (c === '"') inQuotes = true;
        else if (c === delimiter) pushField();
        else if (c === '\n') { pushField(); pushRow(); }
        else if (c === '\r') { /* ignore */ }
        else field += c;
      }
    }
    pushField(); if (row.length > 1 || row[0] !== '') pushRow();
    while (rows.length && rows[rows.length - 1].every(x => x === '')) rows.pop();
    if (!rows.length) return { columns: [], data: [] };
    const header = rows[0].map((h, i) => (h && h.trim()) ? h.trim() : `col_${i+1}`);
    const dataRows = rows.slice(1).filter(r => r.some(v => (v || '').trim() !== ''));
    const data = dataRows.map(r => { const obj = {}; header.forEach((h, i) => obj[h] = (r[i] ?? '').trim()); return obj; });
    return { columns: header, data };
  }

  // ---------- CLIPBOARD ----------
  async function writeClipboard(text) {
    try { await navigator.clipboard.writeText(text); return true; }
    catch (e) {
      try { const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'; ta.style.left = '-9999px'; document.body.appendChild(ta); ta.select(); const ok = document.execCommand('copy'); document.body.removeChild(ta); return ok; } catch { return false; }
    }
  }

  // ---------- MOUNT ----------
  function mounted() { return document.getElementById('dcsv-root'); }
  function safeMount() {
    if (mounted()) return;
    if (!document.documentElement) return;
    const root = document.createElement('div'); root.id = 'dcsv-root';
    document.documentElement.appendChild(root);
    let shadow; try { shadow = root.attachShadow({ mode: 'open' }); } catch { shadow = { appendChild: (n)=> root.appendChild(n) }; }
    buildUI(shadow);
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') safeMount();
  else window.addEventListener('DOMContentLoaded', safeMount, { once: true });

  // ---------- UI ----------
  function buildUI(root) {
    const css = `
      :host { all: initial; }
      .panel { position: fixed; right: 16px; top: 16px; z-index: 2147483647; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; color: #0f172a; }
      .card { width: 380px; background: #fff; border: 1px solid #e5e7eb; border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,.1); overflow: hidden; }
      .hdr { display:flex; align-items:center; justify-content:space-between; padding: 10px 12px; background: #f8fafc; border-bottom: 1px solid #e5e7eb; cursor: move; }
      .title { font-weight: 700; font-size: 14px; }
      .controls { display:flex; gap:6px; }
      .btn { border: 1px solid #e5e7eb; background:#fff; border-radius: 8px; padding:6px 8px; font-size:12px; cursor:pointer; }
      .btn:disabled { opacity:.5; cursor:not-allowed; }
      .btn.primary { background:#0ea5e9; color:#fff; border-color:#0284c7; }
      .btn.warn { background:#fee2e2; border-color:#fecaca; color:#b91c1c; }
      .body { padding: 10px 12px; max-height: 60vh; overflow:auto; }
      .row { display:grid; grid-template-columns: 1fr auto; gap:8px; align-items:center; padding:4px 0; }
      .label { font-size:12px; color:#475569; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      .val { font-size:13px; background:#f1f5f9; border-radius:8px; padding:6px 8px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .footer { display:flex; align-items:center; justify-content:space-between; gap:8px; padding: 10px 12px; border-top:1px solid #e5e7eb; background:#fafafa; }
      .meta { font-size:12px; color:#64748b; }
      .kbd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; background:#e2e8f0; padding:1px 6px; border-radius:6px; }
      .empty { font-size:13px; color:#64748b; padding: 8px; }
      .pill { border:1px dashed #94a3b8; padding:6px 8px; border-radius:8px; font-size:12px; color:#334155; background:#f8fafc; }
      .order { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px; }
      .chip { display:inline-flex; align-items:center; gap:6px; border:1px solid #cbd5e1; background:#f8fafc; border-radius:999px; padding:4px 8px; font-size:12px; cursor:grab; user-select:none; }
      .chip[draggable="true"]:active { cursor:grabbing; }
      .chip .x { border:none; background:transparent; cursor:pointer; font-size:12px; line-height:1; }
      .sep { height:8px; }
      .options { display:flex; gap:8px; align-items:center; margin-top:8px; flex-wrap:wrap; }
      .chk { display:flex; gap:6px; align-items:center; font-size:12px; color:#334155; }

      /* Compact minimize icon */
      .iconBtn {
        position: fixed;
        inset: auto 16px 16px auto;
        z-index: 2147483647;
        width: 36px;
        height: 36px;
        border-radius: 999px;
        border: 1px solid #e5e7eb;
        background:#fff;
        box-shadow: 0 10px 30px rgba(0,0,0,.12);
        display: none;
        align-items: center;
        justify-content: center;
        font-size: 18px;
        cursor: pointer;
        user-select: none;
      }
      .iconBtn:hover { box-shadow: 0 12px 34px rgba(0,0,0,.16); }
    `;
    const style = document.createElement('style'); style.textContent = css; root.appendChild(style);

    // Minimized icon button (compact)
    const mini = document.createElement('button');
    mini.className = 'iconBtn';
    mini.title = 'Show Dynamic Clipboard';
    mini.textContent = '📋';
    root.appendChild(mini);

    const panel = document.createElement('div'); panel.className = 'panel';
    panel.innerHTML = `
      <div class="card">
        <div class="hdr" id="hdr">
          <div class="title">Dynamic Clipboard</div>
          <div class="controls">
            <button class="btn" id="btnPaste">Paste CSV / TSV</button>
            <button class="btn" id="btnCycle">Copy-next <span class="kbd">Alt+Q</span></button>
            <button class="btn warn" id="btnClear" title="Clear CSV data from memory">Clear all</button>
            <button class="btn" id="btnMin" title="Minimise">—</button>
          </div>
        </div>
        <div class="body" id="body"></div>
        <div class="footer">
          <div>
            <div class="meta" id="meta">${restored ? 'Restored session' : 'No data loaded'}</div>
            <div class="options">
              <label class="chk"><input type="checkbox" id="chkInputs"/> Hotkeys work in inputs</label>
              <label class="chk"><input type="checkbox" id="chkKeep"/> Keep data on reload (session)</label>
              <label class="chk">Form URL: <input id="formUrl" placeholder="https://…" style="border:1px solid #e5e7eb; padding:4px 6px; border-radius:6px; width:180px"/></label>
              <button class="btn" id="btnOpenForm" title="Open form URL in this tab">Open</button>
            </div>
          </div>
          <div class="controls">
            <button class="btn" id="btnPrev" title="Alt+P">◀</button>
            <button class="btn primary" id="btnNext" title="Alt+N">Next ▶</button>
          </div>
        </div>
      </div>`;
    root.appendChild(panel);

    // Draggable by header
    (function makeDraggable() {
      const hdr = panel.querySelector('#hdr');
      let sx = 0, sy = 0, px = 0, py = 0, dragging = false;
      hdr.addEventListener('mousedown', e => {
        dragging = true; sx = e.clientX; sy = e.clientY;
        const r = panel.getBoundingClientRect(); px = r.left; py = r.top; e.preventDefault();
      });
      window.addEventListener('mousemove', e => {
        if (!dragging) return;
        const dx = e.clientX - sx, dy = e.clientY - sy;
        panel.style.right = 'auto';
        panel.style.top = (py + dy) + 'px';
        panel.style.left = (px + dx) + 'px';
      });
      window.addEventListener('mouseup', ()=> {
        if (!dragging) return;
        dragging = false;
        const r = panel.getBoundingClientRect();
        lastLeft = r.left;
        lastTop  = r.top;
      });
    })();

    const bodyEl = panel.querySelector('#body');
    const metaEl = panel.querySelector('#meta');
    const chkInputs = panel.querySelector('#chkInputs');
    const chkKeep = panel.querySelector('#chkKeep');
    const formUrlEl = panel.querySelector('#formUrl');

    // initialize from defaults/session
    chkInputs.checked = !!hotkeysWorkInInputs;   // default ON, overridden by session if present
    chkKeep.checked = !!keepOnReload;            // default ON
    if (restored) {
      formUrlEl.value = formURL || '';
    }

    function setMeta(text) { metaEl.textContent = text; }

    function wipeAll() {
      rows = []; columns = []; index = 0; copyCycle = []; cyclePtr = 0; setMeta('Cleared. No data loaded'); saveSession(); render();
    }

    function render() {
      bodyEl.innerHTML = '';
      const btnCycle = panel.querySelector('#btnCycle');
      btnCycle.disabled = copyCycle.length === 0 || !rows.length;

      const btnPrev = panel.querySelector('#btnPrev');
      const btnNext = panel.querySelector('#btnNext');
      btnPrev.disabled = index <= 0 || !rows.length;
      btnNext.disabled = index >= rows.length - 1 || !rows.length;

      if (!rows.length) {
        const empty = document.createElement('div'); empty.className = 'empty';
        empty.innerHTML = `Paste CSV or copy from Sheets/Excel (TSV). First row should be headers.<div class="sep"></div>
          <div class="pill">Tips: Alt+Q copy-next · Alt+N next · Alt+P prev</div>`;
        bodyEl.appendChild(empty);
      } else {
        // Reorder pill (draggable chips)
        if (copyCycle.length) {
          const orderWrap = document.createElement('div'); orderWrap.className = 'order';
          copyCycle.forEach((col, idx) => {
            const chip = document.createElement('div'); chip.className = 'chip'; chip.draggable = true; chip.dataset.idx = String(idx);
            chip.innerHTML = `<span>${col}</span><button class="x" title="Remove">×</button>`;
            chip.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', idx.toString()); });
            chip.addEventListener('dragover', e => { e.preventDefault(); });
            chip.addEventListener('drop', e => {
              e.preventDefault();
              const from = parseInt(e.dataTransfer.getData('text/plain')||'-1',10); const to = idx;
              if (from>=0 && from!==to){ const item = copyCycle.splice(from,1)[0]; copyCycle.splice(to,0,item); cyclePtr = 0; saveSession(); render(); }
            });
            chip.querySelector('.x').addEventListener('click', () => {
              const pos = copyCycle.indexOf(col);
              if (pos!==-1){ copyCycle.splice(pos,1); cyclePtr=0; saveSession(); render(); }
            });
            orderWrap.appendChild(chip);
          });
          bodyEl.appendChild(orderWrap);
        }

        const rec = rows[index];
        columns.forEach(col => {
          const rowEl = document.createElement('div'); rowEl.className = 'row';
          const label = document.createElement('div'); label.className = 'label'; label.textContent = col;
          const right = document.createElement('div'); right.style.display = 'flex'; right.style.gap = '6px'; right.style.alignItems = 'center';
          const val = document.createElement('div'); val.className = 'val'; val.textContent = rec[col] ?? '';
          const btn = document.createElement('button'); btn.className = 'btn'; btn.textContent = 'Copy';
          btn.addEventListener('click', async () => { const ok = await writeClipboard(rec[col] ?? ''); flash(btn, ok); });

          // star toggles inclusion in copyCycle
          const star = document.createElement('button'); star.className = 'btn'; star.textContent = copyCycle.includes(col) ? '★' : '☆'; star.title = copyCycle.includes(col) ? 'Remove from copy order' : 'Add to copy order';
          star.addEventListener('click', () => { const pos = copyCycle.indexOf(col); if (pos === -1) copyCycle.push(col); else copyCycle.splice(pos,1); cyclePtr = 0; saveSession(); render(); });

          right.appendChild(val); right.appendChild(btn); right.appendChild(star);
          rowEl.appendChild(label); rowEl.appendChild(right);
          bodyEl.appendChild(rowEl);
        });
      }

      setMeta(`Record ${rows.length ? (index + 1) : 0} of ${rows.length} • Delimiter: ${humanDelim(activeDelimiter)}`);
    }

    function flash(btn, ok) { const orig = btn.textContent; btn.textContent = ok ? 'Copied!' : 'Copy failed'; btn.disabled = true; setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 700); }

    async function copyNextInCycle() {
      if (!rows.length || !copyCycle.length) return;
      const col = copyCycle[cyclePtr % copyCycle.length];
      const rec = rows[index];
      const text = rec[col] ?? '';
      await writeClipboard(text);
      cyclePtr++;
      const rowsEls = bodyEl.querySelectorAll('.row');
      rowsEls.forEach(r => { if (r.firstChild && r.firstChild.textContent === col) { const btn = r.querySelector('.btn'); if (btn) flash(btn, true); } });
    }

    function next() { if (index < rows.length - 1) { index++; cyclePtr = 0; saveSession(); render(); } }
    function prev() { if (index > 0) { index--; cyclePtr = 0; saveSession(); render(); } }

    // Minimize to compact icon (📋). Keep/restore exact position.
    panel.querySelector('#btnMin').addEventListener('click', () => {
      const r = panel.getBoundingClientRect();
      lastLeft = r.left;
      lastTop  = r.top;
      // park mini near where the panel was
      mini.style.left = Math.min(Math.max(r.right - 44, 8), window.innerWidth - 44) + 'px';
      mini.style.top  = Math.min(Math.max(r.top + 8, 8),    window.innerHeight - 44) + 'px';
      mini.style.right = 'auto';
      mini.style.bottom = 'auto';
      panel.style.display = 'none';
      mini.style.display = 'flex';
    });

    mini.addEventListener('click', () => {
      // If we have a remembered panel position, use it; otherwise use mini’s spot
      if (lastLeft == null || lastTop == null) {
        const r = mini.getBoundingClientRect();
        lastLeft = r.left - 8;
        lastTop  = r.top  - 8;
      }
      panel.style.left = lastLeft + 'px';
      panel.style.top  = lastTop  + 'px';
      panel.style.right = 'auto';
      panel.style.display = '';
      mini.style.display = 'none';
    });

    // Make the mini draggable (so you can move it while minimized)
    (function makeMiniDraggable() {
      let dragging = false, sx = 0, sy = 0, sl = 0, st = 0;
      mini.addEventListener('mousedown', e => {
        dragging = true;
        sx = e.clientX; sy = e.clientY;
        const r = mini.getBoundingClientRect();
        sl = r.left; st = r.top;
        e.preventDefault();
      });
      window.addEventListener('mousemove', e => {
        if (!dragging) return;
        const nx = Math.min(Math.max(sl + (e.clientX - sx), 8), window.innerWidth - 44);
        const ny = Math.min(Math.max(st + (e.clientY - sy), 8), window.innerHeight - 44);
        mini.style.left = nx + 'px';
        mini.style.top  = ny + 'px';
        mini.style.right = 'auto';
        mini.style.bottom = 'auto';
      });
      window.addEventListener('mouseup', () => {
        if (!dragging) return;
        dragging = false;
        // Update the panel’s remembered position so restore opens near the mini
        const r = mini.getBoundingClientRect();
        lastLeft = r.left - 8;
        lastTop  = r.top  - 8;
      });
    })();

    // Keep mini on-screen when viewport changes
    window.addEventListener('resize', () => {
      if (mini.style.display !== 'flex') return;
      const rect = mini.getBoundingClientRect();
      if (rect.right > window.innerWidth || rect.bottom > window.innerHeight) {
        mini.style.left = (window.innerWidth - 44) + 'px';
        mini.style.top  =  '8px';
        mini.style.right = 'auto';
        mini.style.bottom = 'auto';
        // Update remembered panel position accordingly
        lastLeft = window.innerWidth - 52;
        lastTop  = 0;
      }
    });

    panel.querySelector('#btnClear').addEventListener('click', () => { if (confirm('Clear all in-memory CSV data now?')) wipeAll(); });
    panel.querySelector('#btnPrev').addEventListener('click', prev);
    panel.querySelector('#btnNext').addEventListener('click', next);
    panel.querySelector('#btnCycle').addEventListener('click', copyNextInCycle);

    // Persist prefs + URL as they change
    chkInputs.addEventListener('change', () => {
      hotkeysWorkInInputs = chkInputs.checked;
      saveSession();
    });
    chkKeep.addEventListener('change', () => {
      keepOnReload = chkKeep.checked;
      if (!keepOnReload) {
        try { const base = (page.name || '').split(MARK)[0] || ''; page.name = base; } catch {}
      } else {
        saveSession();
      }
    });
    formUrlEl.addEventListener('input', () => {
      formURL = (formUrlEl.value || '').trim();
      saveSession();
    });

    panel.querySelector('#btnOpenForm').addEventListener('click', () => {
      formURL = (formUrlEl.value || '').trim();
      if (!formURL) { alert('Enter a form URL first.'); return; }
      if (!keepOnReload) {
        if (!confirm('Opening in this tab without session keep will lose your data. Enable "Keep data on reload"?')) return;
        keepOnReload = true; chkKeep.checked = true; saveSession();
      } else {
        saveSession();
      }
      page.location.href = formURL;
    });

    // Hotkeys
    window.addEventListener('keydown', (e) => {
      const isTyping = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
      if (isTyping && !hotkeysWorkInInputs) return;
      if (e.altKey && !e.ctrlKey && !e.metaKey) {
        if (e.key === 'q' || e.key === 'Q') { e.preventDefault(); e.stopPropagation(); copyNextInCycle(); }
        if (e.key === 'n' || e.key === 'N') { e.preventDefault(); e.stopPropagation(); next(); }
        if (e.key === 'p' || e.key === 'P') { e.preventDefault(); e.stopPropagation(); prev(); }
      }
    }, true);

    // Paste handler
    panel.querySelector('#btnPaste').addEventListener('click', async () => {
      const { text, chosenDelimiter } = await openPasteDialog(root);
      if (!text) return;
      const delim = chosenDelimiter === 'auto' ? detectDelimiter(text) : chosenDelimiter;
      activeDelimiter = delim;
      const { columns: cols, data } = parseDSV(text, delim);
      if (!data.length) { alert('No data rows found. Make sure the first row is a header.'); return; }
      rows = data; columns = cols; index = 0; copyCycle = [...columns]; cyclePtr = 0; render(); saveSession();
    });

    function humanDelim(d) { return d === '	' ? 'Tab' : (d === ',' ? 'Comma' : d === ';' ? 'Semicolon' : d === '|' ? 'Pipe' : d); }

    function openPasteDialog(root) {
      const wrap = document.createElement('div'); wrap.style.position = 'fixed'; wrap.style.inset = '0'; wrap.style.zIndex = '2147483647'; wrap.style.background = 'rgba(0,0,0,.35)'; wrap.style.display = 'grid'; wrap.style.placeItems = 'center'; wrap.style.fontFamily = 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial';
      const dlg = document.createElement('div'); dlg.style.width = 'min(900px, 90vw)'; dlg.style.background = '#fff'; dlg.style.borderRadius = '12px'; dlg.style.boxShadow = '0 20px 60px rgba(0,0,0,.25)'; dlg.style.padding = '16px'; dlg.style.fontSize = '14px';
      dlg.innerHTML = `
        <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:8px">
          <div style="font-weight:700">Paste CSV or TSV (first row = headers)</div>
          <div style="color:#64748b; font-size:12px">Data lives only in memory and will be wiped on close.</div>
        </div>
        <textarea id="csv" placeholder="first_name	last_name	email
Ada	Lovelace	ada@example.com" style="width:100%; height: 300px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:12px; background:#f8fafc; border:1px solid #e5e7eb; border-radius:10px; padding:10px"></textarea>
        <div style="display:flex; justify-content:space-between; align-items:center; margin-top:10px; gap:8px">
          <div style="font-size:12px; color:#334155">Delimiter:
            <select id="delim" style="font-size:12px; padding:4px 6px; border-radius:6px; border:1px solid #e5e7eb; background:#fff">
              <option value="auto" selected>Auto-detect</option>
              <option value="," >Comma</option>
              <option value="	">Tab</option>
              <option value=";">Semicolon</option>
              <option value="|">Pipe</option>
            </select>
          </div>
          <div style="display:flex; gap:8px; margin-left:auto">
            <button id="cancel" class="btn">Cancel</button>
            <button id="ok" class="btn primary">Load</button>
          </div>
        </div>`;
      wrap.appendChild(dlg); root.appendChild(wrap);
      return new Promise(resolve => {
        const ta = dlg.querySelector('#csv');
        const sel = dlg.querySelector('#delim');
        const finish = (val) => { try { root.removeChild(wrap); } catch{} resolve(val); };
        dlg.querySelector('#cancel').addEventListener('click', () => finish({ text: '', chosenDelimiter: 'auto' }));
        dlg.querySelector('#ok').addEventListener('click', () => finish({ text: ta.value || '', chosenDelimiter: sel.value }));
        setTimeout(()=> ta.focus(), 0);
      });
    }

    window.addEventListener('beforeunload', () => { saveSession(); });

    render();
  }
})();
