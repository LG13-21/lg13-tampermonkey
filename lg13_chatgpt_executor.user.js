// ==UserScript==
// @name         LG13 Executor (ChatGPT <- Server)
// @namespace    lg13.local
// @version      1.0
// @description  Obrácený ingest – přijímá příkazy a vykonává je v ChatGPT UI
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  if (window.__LG13_EXEC__) return;
  window.__LG13_EXEC__ = true;

  const SERVER = 'http://127.0.0.1:8790/pl/chatgpt/commands';
  const ACK    = 'http://127.0.0.1:8790/pl/chatgpt/ack';

  const POLL_MS = 3000;

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

  log('LG13 EXECUTOR ready');
})();