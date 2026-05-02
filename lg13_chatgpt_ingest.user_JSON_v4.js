// ==UserScript==
// @name         ChatGPT → LG13 Ingest (JSON v4 snapshot)
// @namespace    lg13.local
// @version      4.0
// @description  Stable snapshot ingest for LG13 (deterministic, no delta)
// @author       Tom / LG13
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// @run-at       document-idle
// ==/UserScript==

(function() {
  'use strict';

  if (window.__LG13_RUNNING__) return;
  window.__LG13_RUNNING__ = true;

  const LG13_URL = 'http://127.0.0.1:8790/pl/chatgpt/ingest';
  const DEBOUNCE_MS = 2000;

  const log = (...a) => console.log('[LG13]', ...a);
  const err = (...a) => console.error('[LG13-ERR]', ...a);

  function hashStr(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(16);
  }

  function getConvId() {
    const m = location.href.match(/\/c\/([a-f0-9-]{36})/);
    if (m) return m[1];

    const seed = (document.title || '') +
      (document.body.innerText.slice(0, 500) || '');

    return 'fallback_' + hashStr(seed);
  }

  function getConvTitle() {
    const t = document.title || '';
    return t === 'ChatGPT' ? '' : t;
  }

  function extractText(el) {
    const clone = el.cloneNode(true);

    clone.querySelectorAll('button, svg, img').forEach(n => n.remove());

    clone.querySelectorAll('br').forEach(b =>
      b.replaceWith(document.createTextNode('\n'))
    );

    clone.querySelectorAll('p, div, li, h1, h2, h3, pre, blockquote')
      .forEach(b => b.insertAdjacentText('beforebegin', '\n'));

    return (clone.textContent || '')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+\n/g, '\n')
      .trim();
  }

  function extractConversation() {
    const turns = document.querySelectorAll('[data-message-author-role]');
    if (!turns.length) return null;

    const messages = [];
    let idx = 0;

    turns.forEach(el => {
      const role = el.getAttribute('data-message-author-role');
      const text = extractText(el);

      if (!text || text.length < 5) return;

      const id = hashStr(role + '|' + text);

      messages.push({
        id,
        idx,
        role: role === 'user' ? 'user' : 'assistant',
        text,
        ts: new Date().toISOString(),
        ts_source: 'capture'
      });

      idx++;
    });

    return messages;
  }

  function getFingerprint(messages) {
    return hashStr(messages.map(m => m.id).join('|'));
  }

  function send(messages) {
    if (!messages || !messages.length) return;

    const meta = {
      schema: "lg13.v4",
      conv_id: getConvId(),
      title: getConvTitle(),
      url: location.href,
      captured_at: new Date().toISOString(),
      fingerprint: getFingerprint(messages)
    };

    const payload = JSON.stringify({ meta, messages });

    GM_xmlhttpRequest({
      method: 'POST',
      url: LG13_URL,
      headers: { 'Content-Type': 'application/json' },
      data: payload,
      onload: () => log('sent snapshot', messages.length),
      onerror: e => err('send failed', e)
    });
  }

  function isStreaming() {
    return !!document.querySelector('[data-testid="stop-button"]');
  }

  let debounceTimer = null;

  function onChange() {
    if (isStreaming()) return;

    const messages = extractConversation();
    if (!messages) return;

    send(messages);
  }

  function init() {
    const btn = document.createElement('button');
    btn.textContent = '⬡ LG13';

    Object.assign(btn.style, {
      position: 'fixed',
      bottom: '60px',
      right: '16px',
      zIndex: 999999
    });

    btn.onclick = () => {
      const messages = extractConversation();
      send(messages);
    };

    document.body.appendChild(btn);

    const obs = new MutationObserver(() => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(onChange, DEBOUNCE_MS);
    });

    obs.observe(document.body, {
      childList: true,
      subtree: true
    });

    log('LG13 v4 running');
  }

  init();

})();
