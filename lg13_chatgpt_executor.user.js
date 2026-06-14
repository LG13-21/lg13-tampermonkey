// ==UserScript==
// @name         LG13 Executor (ChatGPT <- Server)
// @namespace    lg13.local
// @version      1.5
// @description  Obrácený ingest – příkazy + DOM state heartbeat (#2617 Phase 1) [v1.5: github raw (repo public)]
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_xmlhttpRequest
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
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter',
        bubbles: true
      }));
    }, 100);

    return true;
  }

  async function openChat(url) {
    if (location.href.includes(url)) return true;
    location.href = 'https://chat.openai.com' + url;
    return false; // reload přijde
  }

  function refresh() {
    location.reload();
  }

  // ---- command executor ----------------------------------------------------

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

      write(cmd.text || '');
      return 'ok';
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
      const messages = Array.from(document.querySelectorAll('[data-message-author-role]')).map((el, idx) => {
        const role = el.getAttribute('data-message-author-role');
        const msgId = el.getAttribute('data-message-id') || null;
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

  // ---- polling -------------------------------------------------------------

  function poll() {
    GM_xmlhttpRequest({
      method: 'GET',
      url: SERVER,
      timeout: 5000,
      onload: async (resp) => {
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
    if (input && sendBtn && !sendBtn.disabled) {
      return 'idle';
    }
    // busy: transitional (just submitted, not yet streaming) or input not ready
    return 'busy';
  }

  let __lastHeartbeat = { tid: null, status: null };

  function heartbeat() {
    const tid = getThreadId();
    if (!tid) return; // /c/<id> only — new-conv root skipped
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
      timeout: 3000
    });
    if (__lastHeartbeat.tid !== tid || __lastHeartbeat.status !== status) {
      log('state', tid, status);
      __lastHeartbeat = { tid, status };
    }
  }

  setInterval(heartbeat, HEARTBEAT_MS);

  log('LG13 EXECUTOR v1.1 ready (cmd poll ' + POLL_MS + 'ms + state heartbeat ' + HEARTBEAT_MS + 'ms)');
})();