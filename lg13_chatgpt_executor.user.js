// ==UserScript==
// @name         LG13 Executor (ChatGPT <- Server)
// @namespace    lg13.local
// @version      1.1
// @description  Obrácený ingest – příkazy + DOM state heartbeat (#2617 Phase 1)
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/coder/anti-spam-2026-05-09/lg13_chatgpt_executor.user.js
// @downloadURL  https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/coder/anti-spam-2026-05-09/lg13_chatgpt_executor.user.js
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