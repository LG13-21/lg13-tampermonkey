// ==UserScript==
// @name         LG13 Executor (ChatGPT <- Server)
// @namespace    lg13.local
// @version      1.11
// @description  Obrácený ingest – příkazy + DOM state heartbeat (#2617 Phase 1) [v1.5: github raw (repo public)] [v1.9: per-thread ON/OFF badge] [v1.10: PL link indicator] [v1.11: attachments + upload_source]
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @connect      127.0.0.1
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/main/lg13_chatgpt_executor.user.js
// @downloadURL  https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/main/lg13_chatgpt_executor.user.js
// ==/UserScript==

(function () {
  'use strict';

  if (window.__LG13_EXEC__) return;
  window.__LG13_EXEC__ = true;

  const SERVER = 'http://127.0.0.1:8790/pl/chatgpt/commands';
  const ACK    = 'http://127.0.0.1:8790/pl/chatgpt/ack';
  const STATE  = 'http://127.0.0.1:8790/pl/chatgpt/state';

  const POLL_MS      = 3000;
  const HEARTBEAT_MS = 1000;

  const log = (...a) => console.log('[LG13-EXEC]', ...a);

  // ---- helpers -------------------------------------------------------------

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function getInput() {
    return document.querySelector('textarea, [contenteditable="true"]');
  }

  async function waitForInput(timeout = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const el = getInput();
      if (el) return el;
      await sleep(200);
    }
    return null;
  }

  function write(text) {
    const el = getInput();
    if (!el) return false;

    el.focus();
    document.execCommand('insertText', false, text);

    setTimeout(() => {
      const btn = document.querySelector('button[data-testid="send-button"]')
               || document.querySelector('button[aria-label*="end" i][type="submit"]');
      if (btn && !btn.disabled) { btn.click(); return; }
      el.dispatchEvent(new KeyboardEvent('keydown', {key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true}));
    }, 400);

    return true;
  }

  // ---- attachments (v1.11) ------------------------------------------------------
  const FILE_URL = 'http://127.0.0.1:8790/pl/chatgpt/file?f=';

  function fetchStaged(att) {
    return new Promise(resolve => {
      GM_xmlhttpRequest({
        method: 'GET', url: FILE_URL + encodeURIComponent(att.file), responseType: 'arraybuffer', timeout: 30000,
        onload: r => (r.status === 200 && r.response && r.response.byteLength)
          ? resolve(new File([r.response], att.name, {type: att.mime || 'application/octet-stream'}))
          : resolve(null),
        onerror: () => resolve(null), ontimeout: () => resolve(null),
      });
    });
  }

  function fileInput() {
    const all = document.querySelectorAll('input[type="file"]');
    return all.length ? all[all.length - 1] : null;
  }

  function setFiles(input, files) {
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event('input', {bubbles: true}));
    input.dispatchEvent(new Event('change', {bubbles: true}));
  }

  function pasteFiles(target, files) {
    const dt = new DataTransfer();
    files.forEach(f => dt.items.add(f));
    target.focus();
    target.dispatchEvent(new ClipboardEvent('paste', {clipboardData: dt, bubbles: true, cancelable: true}));
  }

  // vrati 'ok' nebo 'attach_failed:<krok>' (zadny tichy uspech)
  async function attachToComposer(attachments) {
    const files = [];
    for (const att of attachments) {
      const f = await fetchStaged(att);
      if (!f) return 'attach_failed:fetch_' + att.name;
      files.push(f);
    }
    const input = await waitForInput();
    if (!input) return 'attach_failed:no_composer';
    const fi = fileInput();
    if (fi) setFiles(fi, files); else pasteFiles(input, files);
    // pocka na nahrani: nazev souboru v composeru a zadny progress; po 60 s chyba
    const t0 = Date.now();
    let seen = false;
    while (Date.now() - t0 < 60000) {
      await sleep(500);
      const form = input.closest('form') || document;
      const txt = form.textContent || '';
      seen = files.every(f => txt.includes(f.name) || txt.includes(f.name.replace(/\.[^.]+$/, '')));
      const busy = form.querySelector('[role="progressbar"], [data-testid*="uploading" i], .animate-spin');
      if (seen && !busy && Date.now() - t0 > 1500) return 'ok';
    }
    return seen ? 'attach_failed:upload_timeout' : 'attach_failed:preview_not_shown';
  }

  async function uploadSource(cmd) {
    if (cmd.url && !location.href.includes(String(cmd.url).replace(/^https?:\/\/[^/]+/, ''))) {
      openChat(cmd.url);
      return 'nav';
    }
    if (cmd.replace) return 'upload_failed:replace_unsupported';
    const files = [];
    for (const att of (cmd.files || [])) {
      const f = await fetchStaged(att);
      if (!f) return 'upload_failed:fetch_' + att.name;
      files.push(f);
    }
    if (!files.length) return 'upload_failed:no_files';
    let fi = fileInput();
    if (!fi) {
      const btn = Array.from(document.querySelectorAll('button,[role="button"],[role="tab"],a'))
        .find(b => /add files|add file|přidat soubor|nahrát|upload/i.test((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')));
      if (!btn) return 'upload_failed:no_add_button';
      btn.click();
      for (let i = 0; i < 20 && !(fi = fileInput()); i++) await sleep(250);
      if (!fi) return 'upload_failed:no_file_input';
    }
    setFiles(fi, files);
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      await sleep(1000);
      const txt = document.body.textContent || '';
      const busy = document.querySelector('[role="progressbar"], .animate-spin');
      if (files.every(f => txt.includes(f.name)) && !busy && Date.now() - t0 > 2500) return 'ok';
    }
    return 'upload_failed:not_confirmed';
  }

  async function openChat(url) {
    if (location.href.includes(url)) return true;
    location.href = url.startsWith('http') ? url : location.origin + url;
    return false; // reload přijde
  }

  function refresh() {
    location.reload();
  }

  // ---- command executor ----------------------------------------------------

  // <lg13-turns>
  // ChatGPT zmenil DOM: stary [data-message-author-role] (div s data-message-id) vs novy
  // virtualizovany [data-chatgpt-search-unit-key="<turn>:<n>:user|assistant"] s id zpravy
  // v data-chatgpt-search-message-ids. Stary ma prednost; zadny z nich = prazdny seznam.
  function lg13GetTurns(root) {
    root = root || document;
    const old = root.querySelectorAll('[data-message-author-role]');
    if (old.length) {
      return Array.from(old).map(el => ({
        el: el, role: el.getAttribute('data-message-author-role'), msgId: el.getAttribute('data-message-id') || null
      }));
    }
    const out = [];
    root.querySelectorAll('[data-chatgpt-search-unit-key]').forEach(unit => {
      const m = /:(user|assistant)$/.exec(unit.getAttribute('data-chatgpt-search-unit-key') || '');
      if (!m) return;
      const ids = (unit.getAttribute('data-chatgpt-search-message-ids') || '').split(/\s+/).filter(Boolean);
      const body = m[1] === 'user'
        ? unit.querySelector('[data-user-message-bubble]')
        : unit.querySelector('[data-chatgpt-selection-message-id]');
      out.push({ el: body || unit, role: m[1], msgId: ids[0] || null });
    });
    return out;
  }
  // </lg13-turns>

  async function execute(cmd) {
    log('cmd', cmd);

    if (cmd.type === 'open') {
      openChat(cmd.url);
      return 'ok';
    }

    if (cmd.type === 'write') {
      if (cmd.url && !location.href.includes(cmd.url)) {
        openChat(cmd.url);
        return 'nav'; // počkej na reload
      }

      const input = await waitForInput();
      if (!input) return 'no_input';

      if (Array.isArray(cmd.attachments) && cmd.attachments.length) {
        const ar = await attachToComposer(cmd.attachments);
        if (ar !== 'ok') { log('attach failed', ar); return ar; }
      }
      write(cmd.text || '');
      return 'ok';
    }

    if (cmd.type === 'upload_source') {
      const ur = await uploadSource(cmd);
      if (ur !== 'ok' && ur !== 'nav') log('upload failed', ur);
      return ur;
    }

    if (cmd.type === 'refresh') {
      refresh();
      return 'ok';
    }

    if (cmd.type === 'ping') {
      return 'pong';
    }

    if (cmd.type === 'read_conv') {
      if (cmd.url && !location.href.includes(cmd.url)) {
        openChat(cmd.url);
        return 'nav';
      }
      await sleep(cmd.wait_ms || 4000);
      const conv_id_m = location.pathname.match(/\/c\/([a-f0-9-]+)/i);
      const conv_id = conv_id_m ? conv_id_m[1] : 'unknown';
      const messages = lg13GetTurns(document).map(({ el, role, msgId }, idx) => {
        const clone = el.cloneNode(true);
        clone.querySelectorAll('button,svg,img').forEach(n => n.remove());
        clone.querySelectorAll('br').forEach(b => b.replaceWith(document.createTextNode('\n')));
        const text = (clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
        if (text.length < 5) return null;
        let h = 0; for (const c of (role + '|' + text)) h = ((31 * h) + c.charCodeAt(0)) >>> 0;
        return {role: role === 'user' ? 'user' : 'assistant', text, idx, msg_id: msgId,
                id: h.toString(16), ts: new Date().toISOString(), ts_source: 'tm_read_conv'};
      }).filter(Boolean);
      if (!messages.length) return 'no_messages';
      let fpH = 0; for (const m of messages) for (const c of m.id) fpH = ((31 * fpH) + c.charCodeAt(0)) >>> 0;
      const payload = JSON.stringify({
        meta: {schema: 'lg13.v4.7', conv_id, title: document.title,
               url: location.href, captured_at: new Date().toISOString(),
               fingerprint: fpH.toString(16), source: 'tm_read_conv'},
        messages
      });
      return await new Promise(resolve => {
        GM_xmlhttpRequest({
          method: 'POST', url: 'http://127.0.0.1:8790/pl/chatgpt/ingest',
          headers: {'Content-Type': 'application/json'}, data: payload,
          timeout: 10000,
          onload: r => resolve('ok_' + messages.length + 'msgs'),
          onerror: e => resolve('ingest_err'),
          ontimeout: () => resolve('ingest_timeout'),
        });
      });
    }

    return 'unknown';
  }

  // ---- per-thread ON/OFF (default ON, stored in Tampermonkey storage) -------

  const VERSION = '1.11';
  let __plOkTs = 0;
  const plOk = (resp) => { if (resp && resp.status >= 200 && resp.status < 300) __plOkTs = Date.now(); };
  const OFF_PREFIX = 'lg13_exec_off_';

  function isEnabled() {
    const tid = getThreadId();
    return !tid || !GM_getValue(OFF_PREFIX + tid, false);
  }

  let __badge = null;
  let __badgeText = '';

  function renderBadge() {
    const tid = getThreadId();
    if (!__badge) {
      __badge = document.createElement('div');
      __badge.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483646;'
        + 'font:11px/1 system-ui,sans-serif;padding:4px 8px;border-radius:10px;'
        + 'background:#111;color:#ddd;border:1px solid #444;cursor:pointer;user-select:none;opacity:.85';
      __badge.addEventListener('click', () => {
        const t = getThreadId();
        if (!t) return;
        GM_setValue(OFF_PREFIX + t, isEnabled());
        renderBadge();
      });
      document.body.appendChild(__badge);
    }
    let text, color;
    if (!tid) { text = '○ TM Executor ' + VERSION + ' · no thread'; color = '#444'; }
    else if (isEnabled()) {
      const pl = Date.now() - __plOkTs < 6000;
      text = '● TM Executor ' + VERSION + ' · ON · PL ' + (pl ? '✓' : '✗');
      color = pl ? '#16a34a' : '#d97706';
    }
    else { text = '● TM Executor ' + VERSION + ' · OFF'; color = '#dc2626'; }
    if (text !== __badgeText) {
      __badgeText = text;
      __badge.textContent = text;
      __badge.style.borderColor = color;
      __badge.style.color = color === '#444' ? '#ddd' : color;
      __badge.title = 'Klik: zapnout/vypnout executor pro toto vlákno';
    }
  }

  setInterval(renderBadge, 1000);
  renderBadge();

  // ---- polling -------------------------------------------------------------

  function poll() {
    if (!isEnabled()) return;
    GM_xmlhttpRequest({
      method: 'GET',
      url: SERVER + '?thread_id=' + encodeURIComponent(getThreadId() || 'none'),
      timeout: 5000,
      onload: async (resp) => {
        plOk(resp);
        let cmds = [];
        try {
          cmds = JSON.parse(resp.responseText);
        } catch (_) {}

        if (!Array.isArray(cmds) || !cmds.length) return;

        for (const cmd of cmds) {
          const result = await execute(cmd);

          GM_xmlhttpRequest({
            method: 'POST',
            url: ACK,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({
              id: cmd.id,
              result: result,
              ts: new Date().toISOString()
            })
          });

          if (result === 'nav') return; // čekáme na reload
        }
      }
    });
  }

  setInterval(poll, POLL_MS);

  // ---- DOM state heartbeat (#2617 Phase 1) ---------------------------------

  function getThreadId() {
    const m = location.pathname.match(/\/c\/([a-f0-9-]+)/i);
    return m ? m[1] : null;
  }

  function detectState() {
    // streaming: ChatGPT je in flight (stop button visible)
    if (document.querySelector('button[data-testid="stop-button"]')) {
      return 'streaming';
    }
    if (document.querySelector('[data-message-streaming="true"]')) {
      return 'streaming';
    }
    // idle: send button enabled + input field present
    const sendBtn = document.querySelector('button[data-testid="send-button"]')
                 || document.querySelector('button[aria-label*="end" i][type="submit"]');
    const input = getInput();
    if (input && (!sendBtn || !sendBtn.disabled || !(input.value || input.textContent || '').trim())) {
      return 'idle';
    }
    // busy: transitional (just submitted, not yet streaming) or input not ready
    return 'busy';
  }

  let __lastHeartbeat = { tid: null, status: null };

  function heartbeat() {
    const tid = getThreadId();
    if (!tid) return; // /c/<id> only — new-conv root skipped
    if (!isEnabled()) return;
    const status = detectState();
    // Coalesce: same tid+status → still send (server overwrites ts).
    // No deduplication here; PL is cheap and gives PL freshest ts.
    GM_xmlhttpRequest({
      method: 'POST',
      url: STATE,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({
        thread_id: tid,
        status: status,
        ts: new Date().toISOString()
      }),
      timeout: 3000,
      onload: plOk
    });
    if (__lastHeartbeat.tid !== tid || __lastHeartbeat.status !== status) {
      log('state', tid, status);
      __lastHeartbeat = { tid, status };
    }
  }

  setInterval(heartbeat, HEARTBEAT_MS);

  log('LG13 EXECUTOR v1.1 ready (cmd poll ' + POLL_MS + 'ms + state heartbeat ' + HEARTBEAT_MS + 'ms)');
})();