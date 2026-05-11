// ==UserScript==
// @name         LG13 ChatGPT Full Conv Loader
// @namespace    lg13.local
// @version      1.1
// @description  Manual button — scroll to top, then slow PgDn-style scroll down to force-load entire long conv into DOM (so LG13 ingest sees all messages) [v1.1: + @updateURL]
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/coder/anti-spam-2026-05-09/lg13_chatgpt_full_loader.user.js
// @downloadURL  https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/coder/anti-spam-2026-05-09/lg13_chatgpt_full_loader.user.js
// ==/UserScript==

// USE CASE:
//   ChatGPT lazy-loads long conversations — only visible messages exist in
//   DOM. LG13 v4.7 ingest extracts only DOM-present turns -> partial POST.
//   This script: scroll to TOP (ChatGPT loads earliest messages), wait for
//   stabilize, then slow-scroll DOWN by viewport-height steps so every
//   batch lazy-loads. End -> all messages in DOM -> trigger LG13 ingest
//   button (auto if found) for full snapshot.

(function () {
  'use strict';

  if (window.__LG13_FULL_LOADER__) return;
  window.__LG13_FULL_LOADER__ = true;

  // ---- config --------------------------------------------------------------
  const SCROLL_DOWN_INTERVAL_MS = 800;   // pause between PgDn steps
  const STABILIZE_MS            = 1500;  // wait for lazy-load after scroll
  const TOP_STABILIZE_MAX_MS    = 30000; // give up loading older if no growth
  const STEP_RATIO              = 0.85;  // viewport fraction per scroll step
  const MAX_DOWN_STEPS          = 500;   // safety cap (~7 min @ 800ms)

  const log = (...a) => console.log('[LG13-LOADER]', ...a);

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  // ---- find scrollable container ------------------------------------------
  // ChatGPT main thread scrolls inside an inner div, NOT window.
  // Heuristic: deepest <main> descendant with overflow-y:auto/scroll AND
  // contains data-message-author-role nodes.
  function findScrollContainer() {
    const turns = document.querySelectorAll('[data-message-author-role]');
    if (turns.length === 0) return document.scrollingElement;

    let el = turns[0].parentElement;
    while (el && el !== document.body) {
      const cs = getComputedStyle(el);
      if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') &&
          el.scrollHeight > el.clientHeight) {
        return el;
      }
      el = el.parentElement;
    }
    return document.scrollingElement;
  }

  // ---- phase 1: scroll to top, wait until lazy-load stops growing ---------
  async function scrollToTopAndStabilize(container) {
    log('phase 1: scroll to top');
    setStatus('scroll top...', '#fbbf24');

    let lastHeight = -1;
    let lastGrowAt = Date.now();

    while (true) {
      container.scrollTo({ top: 0, behavior: 'auto' });
      await sleep(STABILIZE_MS);

      const h = container.scrollHeight;
      const stillAtTop = container.scrollTop <= 4;

      if (h !== lastHeight) {
        log('  grew', lastHeight, '->', h);
        lastHeight = h;
        lastGrowAt = Date.now();
        continue;
      }

      // no growth this iteration
      if (stillAtTop && (Date.now() - lastGrowAt) >= TOP_STABILIZE_MS_GUARD()) {
        log('phase 1 done — height stable at', h);
        return;
      }
      // not yet at top? push again
      if (!stillAtTop) continue;
      // stable + at top but waiting grace period
      await sleep(500);
      if ((Date.now() - lastGrowAt) >= TOP_STABILIZE_MAX_MS) {
        log('phase 1 give up after', TOP_STABILIZE_MAX_MS, 'ms');
        return;
      }
    }
  }
  function TOP_STABILIZE_MS_GUARD() { return 3500; }

  // ---- phase 2: slow scroll down by viewport steps ------------------------
  async function slowScrollDown(container) {
    log('phase 2: slow scroll down');
    let steps = 0;
    let lastHeight = container.scrollHeight;

    while (steps < MAX_DOWN_STEPS) {
      const step = Math.max(200, Math.floor(container.clientHeight * STEP_RATIO));
      container.scrollBy({ top: step, behavior: 'auto' });
      steps++;

      const pos = container.scrollTop + container.clientHeight;
      const total = container.scrollHeight;
      setStatus('scroll ' + steps + '/' + MAX_DOWN_STEPS +
                '  ' + Math.round(100 * pos / total) + '%',
                '#fbbf24');

      await sleep(SCROLL_DOWN_INTERVAL_MS);

      // bottom reached AND no further growth -> stop
      const atBottom = (pos >= total - 4);
      if (atBottom) {
        await sleep(STABILIZE_MS);
        if (container.scrollHeight === total) {
          log('phase 2 done at step', steps, '— bottom + stable');
          return;
        }
      }
      lastHeight = container.scrollHeight;
    }
    log('phase 2 hit MAX_DOWN_STEPS', MAX_DOWN_STEPS);
  }

  // ---- phase 3: trigger LG13 ingest manual button (if installed) ----------
  function triggerLg13Send() {
    // LG13 v4.7 button lives in a shadow-DOM host #lg13-shadow-host
    const host = document.getElementById('lg13-shadow-host');
    if (host && host.shadowRoot) {
      const btn = host.shadowRoot.getElementById('btn');
      if (btn) {
        log('phase 3: triggering LG13 ingest send');
        btn.click();
        return true;
      }
    }
    log('phase 3: LG13 ingest button not found (skip)');
    return false;
  }

  // ---- orchestrator -------------------------------------------------------
  let running = false;
  async function fullLoadRun() {
    if (running) {
      log('already running, ignoring click');
      return;
    }
    running = true;
    setStatus('start...', '#fbbf24');
    try {
      const container = findScrollContainer();
      log('container:', container.tagName, container.className);
      await scrollToTopAndStabilize(container);
      await slowScrollDown(container);
      const sent = triggerLg13Send();
      setStatus(sent ? 'done + ingest fired' : 'done (no ingest)', '#4ade80');
    } catch (e) {
      console.error('[LG13-LOADER]', e);
      setStatus('err: ' + (e.message || e), '#f87171');
    } finally {
      running = false;
    }
  }

  // ---- shadow-DOM button --------------------------------------------------
  let shadow = null;
  let statusEl = null;

  function buildUI() {
    const host = document.createElement('div');
    host.id = 'lg13-loader-host';
    Object.assign(host.style, {
      position: 'fixed', bottom: '0', right: '0', width: '0', height: '0',
      zIndex: '2147483646', pointerEvents: 'none', overflow: 'visible'
    });
    document.body.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = [
      ':host { all: initial; }',
      '#btn { position: fixed; bottom: 100px; right: 16px; z-index: 2147483646;',
      '       background: #1e1b07; border: 1px solid #92400e; color: #fbbf24;',
      '       padding: 6px 12px; border-radius: 6px; font-size: 11px;',
      '       cursor: pointer; font-family: monospace; font-weight: 600;',
      '       box-shadow: 0 2px 8px rgba(0,0,0,.6); pointer-events: auto;',
      '       user-select: none; }',
      '#btn:hover { background: #2a2510; border-color: #fbbf24; }',
      '#st { position: fixed; bottom: 130px; right: 16px; z-index: 2147483646;',
      '      padding: 4px 8px; border-radius: 4px; font-size: 10px;',
      '      font-family: monospace; background: #0c0a04; border: 1px solid #92400e;',
      '      color: #fbbf24; pointer-events: none; opacity: 0;',
      '      transition: opacity 0.3s; white-space: nowrap; }'
    ].join('\n');
    shadow.appendChild(style);

    const btn = document.createElement('button');
    btn.id = 'btn';
    btn.textContent = '⇑ LOAD ALL';
    btn.title = 'Scroll na top + pomale slow scroll dolu => force lazy-load cele konv => LG13 ingest';
    btn.addEventListener('click', () => { fullLoadRun(); });
    shadow.appendChild(btn);

    statusEl = document.createElement('div');
    statusEl.id = 'st';
    shadow.appendChild(statusEl);
  }

  let statusTimer = null;
  function setStatus(msg, color) {
    if (!statusEl) return;
    statusEl.textContent = msg;
    statusEl.style.color = color || '#fbbf24';
    statusEl.style.borderColor = color || '#92400e';
    statusEl.style.opacity = '1';
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { statusEl.style.opacity = '0'; }, 6000);
  }

  buildUI();

  // self-heal if DOM blows away the host
  setInterval(() => {
    if (!document.getElementById('lg13-loader-host')) {
      shadow = null;
      statusEl = null;
      buildUI();
    }
  }, 5000);

  log('LG13 Full Loader v1.0 ready');
})();
