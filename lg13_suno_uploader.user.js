// ==UserScript==
// @name         Suno → LG13 Lyrics Uploader & Downloader
// @namespace    lg13.local
// @version      2.7
// @description  Server-driven: applies edited lyrics from LG13 to Suno songs and triggers downloads. [v2.7: pl_server proxy]
// @author       Tom / LG13
// @match        https://suno.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      127.0.0.1
// @run-at       document-idle
// @updateURL    http://127.0.0.1:8790/pl/tmonkey/lg13_suno_uploader.user.js
// @downloadURL  http://127.0.0.1:8790/pl/tmonkey/lg13_suno_uploader.user.js
// ==/UserScript==

(function() {
  'use strict';

  const LG13_BASE     = 'http://127.0.0.1:8790';
  const STEP_DELAY_MS = 3000;   // wait after navigation for page load
  const SAVE_DELAY_MS = 2000;   // wait after save click
  const MAX_LIMIT_KEY = 'lg13_suno_max_limit';
  const RUNNING_KEY   = 'lg13_suno_running';
  const COUNT_KEY     = 'lg13_suno_count';

  // ── HTTP helpers ─────────────────────────────────────────────────────────
  function gmFetch(method, url, body) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method, url,
        headers: { 'Content-Type': 'application/json' },
        data: body ? JSON.stringify(body) : undefined,
        timeout: 60000,
        onload(resp) {
          try { resolve(JSON.parse(resp.responseText)); }
          catch { resolve({}); }
        },
        onerror() { reject(new Error('LG13 offline')); },
        ontimeout() { reject(new Error('timeout')); },
      });
    });
  }

  function detectCurrentAccount() {
    // Find the "credits" text element (in profile button) and look for nearby user handle
    const all = Array.from(document.querySelectorAll('*'));
    const creditsEl = all.find(el => el.children.length === 0 && /\d+\s*credits?/i.test(el.textContent || ''));
    if (creditsEl) {
      let p = creditsEl.parentElement;
      for (let i = 0; i < 6 && p; i++) {
        const link = p.querySelector('a[href^="/@"]');
        if (link) return link.getAttribute('href').replace('/@', '');
        const txt = p.innerText || '';
        const m = txt.match(/^([\w]+)\n?\s*\d+\s*credits/i);
        if (m) return m[1];
        p = p.parentElement;
      }
    }
    // Fallback: most frequent /@ link
    const links = Array.from(document.querySelectorAll('a[href^="/@"]'));
    if (!links.length) return '13velkejkluk';
    const counts = {};
    for (const a of links) {
      const h = a.getAttribute('href').replace('/@', '');
      counts[h] = (counts[h] || 0) + 1;
    }
    return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  }

  function getNextSong() {
    const account = detectCurrentAccount();
    return gmFetch('GET', `${LG13_BASE}/pl/suno/next_song?account=${encodeURIComponent(account)}`);
  }
  function reportUploaded(id) {
    return gmFetch('POST', `${LG13_BASE}/pl/suno/upload_result`, {
      id, status: 'uploaded', ts: new Date().toISOString(),
    });
  }
  function reportFailed(id, reason) {
    return gmFetch('POST', `${LG13_BASE}/pl/suno/upload_result`, {
      id, status: 'failed_' + reason, ts: new Date().toISOString(),
    });
  }
  function downloadSong(id) {
    return gmFetch('POST', `${LG13_BASE}/pl/suno/download_song`, { id });
  }

  // ── React-aware textarea setter ───────────────────────────────────────────
  function setReactValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  function findButton(text) {
    return Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === text);
  }

  // ── Process current page (assumes we're on a song page) ───────────────────
  // Wait for an element matching condition (with retries)
  async function waitFor(predicate, maxMs, intervalMs) {
    maxMs = maxMs || 10000;
    intervalMs = intervalMs || 300;
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const result = predicate();
      if (result) return result;
      await sleep(intervalMs);
    }
    return null;
  }

  async function processCurrentSong(songData) {
    if (!songData) return false;

    showStatus(`cekam na load: ${songData.title.slice(0, 25)}`, '#93c5fd');

    // 1. Wait for Edit Displayed Lyrics button (page must finish loading)
    const editBtn = await waitFor(() => findButton('Edit Displayed Lyrics'), 15000, 500);
    if (!editBtn) {
      // Maybe editor already open from previous attempt — close it via Discard
      const discardBtn = findButton('Discard');
      if (discardBtn) {
        discardBtn.click();
        await sleep(1500);
        const editBtn2 = await waitFor(() => findButton('Edit Displayed Lyrics'), 5000);
        if (editBtn2) {
          editBtn2.click();
        } else {
          await reportFailed(songData.id, 'no_edit_btn_after_discard');
          showStatus(`CHYBA: po discard nenalezen edit`, '#fb923c');
          return false;
        }
      } else {
        await reportFailed(songData.id, 'edit_btn_timeout');
        showStatus(`CHYBA: edit btn timeout (15s)`, '#fb923c');
        return false;
      }
    } else {
      showStatus(`klikam Edit`, '#93c5fd');
      editBtn.click();
    }

    // 2. Wait for the lyrics textarea to appear (must have substantial content)
    const ta = await waitFor(() => {
      const tas = Array.from(document.querySelectorAll('textarea'));
      // Find textarea that has the song's lyrics — must be substantial AND have a Save sibling
      return tas.find(t => {
        if (!t.value || t.value.length < 50) return false;
        // Verify it's the lyrics editor (has Save button as cousin)
        let p = t.parentElement;
        for (let i = 0; i < 8 && p; i++) {
          if (Array.from(p.querySelectorAll('button')).some(b => b.textContent.trim() === 'Save')) {
            return true;
          }
          p = p.parentElement;
        }
        return false;
      });
    }, 5000, 200);

    if (!ta) {
      await reportFailed(songData.id, 'textarea_not_found');
      showStatus(`CHYBA: lyrics textarea nenalezena`, '#fb923c');
      return false;
    }

    showStatus(`vkladam novy text`, '#93c5fd');
    setReactValue(ta, songData.lyrics_edited);
    await sleep(800);

    // 3. Click Save (wait until enabled)
    const saveBtn = await waitFor(() => {
      const b = findButton('Save');
      return b && !b.disabled ? b : null;
    }, 5000, 200);
    if (!saveBtn) {
      await reportFailed(songData.id, 'save_btn_not_found');
      showStatus(`CHYBA: save btn`, '#fb923c');
      return false;
    }
    showStatus(`klikam Save`, '#93c5fd');
    saveBtn.click();
    await sleep(SAVE_DELAY_MS);

    // 4. Update title via Edit Song Details (if new_title provided)
    if (songData.new_title && songData.new_title.trim()) {
      showStatus(`upravuji title`, '#93c5fd');
      await sleep(1500); // wait for lyrics save modal to close

      const editDetailsBtn = await waitFor(
        () => document.querySelector('button[aria-label="Edit Song Details"]'),
        5000
      );
      if (editDetailsBtn) {
        editDetailsBtn.click();
        await sleep(1500);

        // Find title input (first text input that's not emoji search)
        const titleInput = await waitFor(() => {
          const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'))
            .filter(i => i.offsetParent && i.getAttribute('aria-label') !== 'Type to search for an emoji');
          return inputs[0] || null;
        }, 3000);

        if (titleInput) {
          setReactValue(titleInput, songData.new_title);
          await sleep(800);

          // Find Save button in this modal
          const titleSaveBtn = await waitFor(() => {
            const b = findButton('Save');
            return b && !b.disabled ? b : null;
          }, 3000);
          if (titleSaveBtn) {
            titleSaveBtn.click();
            await sleep(2000);
            showStatus(`title OK`, '#4ade80');
          }
        }
      }
    }

    // 5. Report uploaded
    await reportUploaded(songData.id);

    // 6. Trigger download
    showStatus(`stahuji audio+image: ${songData.title.slice(0, 20)}`, '#93c5fd');
    await downloadSong(songData.id);

    return true;
  }

  // ── Main loop: ask server for next, navigate, process, repeat ─────────────
  async function runLoop() {
    if (GM_getValue(RUNNING_KEY, '') !== '1') return;

    let count = parseInt(GM_getValue(COUNT_KEY, '0')) || 0;
    const maxLimit = parseInt(GM_getValue(MAX_LIMIT_KEY, '0')) || 0;

    if (maxLimit > 0 && count >= maxLimit) {
      GM_setValue(RUNNING_KEY, '');
      showStatus(`HOTOVO: ${count}/${maxLimit} (limit dosazen)`, '#4ade80');
      return;
    }

    let next;
    try {
      next = await getNextSong();
    } catch (e) {
      showStatus(`server err: ${e.message}`, '#f87171');
      return;
    }

    if (next.done || !next.next) {
      GM_setValue(RUNNING_KEY, '');
      showStatus(`HOTOVO: ${count} songu uploadnuto`, '#4ade80');
      return;
    }

    const targetUrl = `https://suno.com/song/${next.next.id}`;
    if (!location.href.startsWith(targetUrl)) {
      // Navigate; init() on next page will detect RUNNING_KEY and resume
      showStatus(`navigace: ${next.next.title.slice(0, 30)}`, '#a78bfa');
      await sleep(500);
      location.href = targetUrl;
      return;
    }

    // Already on target page — process it
    const ok = await processCurrentSong(next.next);
    if (ok) {
      count += 1;
      GM_setValue(COUNT_KEY, String(count));
      showStatus(`OK [${count}${maxLimit ? '/' + maxLimit : ''}]`, '#4ade80');
    }

    // Continue loop after a pause
    await sleep(2000);
    runLoop();
  }

  // ── Start / Stop ──────────────────────────────────────────────────────────
  function startUpload(maxLimit) {
    GM_setValue(RUNNING_KEY, '1');
    GM_setValue(MAX_LIMIT_KEY, String(maxLimit || 0));
    GM_setValue(COUNT_KEY, '0');
    showStatus(`spoustim${maxLimit ? ' (max ' + maxLimit + ')' : ''}...`, '#a78bfa');
    setTimeout(runLoop, 500);
  }

  function stopUpload() {
    GM_setValue(RUNNING_KEY, '');
    GM_setValue(COUNT_KEY, '0');
    showStatus('zastaveno', '#fb923c');
  }

  // ── UI ────────────────────────────────────────────────────────────────────
  let shadow = null;
  let statusTimer = null;

  function buildUI() {
    if (shadow) return;
    const host = document.createElement('div');
    host.id = 'lg13-suno-uploader-host';
    Object.assign(host.style, {
      position: 'fixed', bottom: '0', left: '0',
      width: '0', height: '0', zIndex: '2147483647',
      pointerEvents: 'none', overflow: 'visible',
    });
    document.body.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        .btn {
          position: fixed; left: 16px; z-index: 2147483647;
          border-radius: 6px; font-size: 11px;
          cursor: pointer; font-family: monospace; font-weight: 600;
          box-shadow: 0 2px 8px rgba(0,0,0,.6); pointer-events: auto;
          padding: 6px 12px; border: 1px solid;
        }
        #upl-start {
          bottom: 180px;
          background: #0f172a; border-color: #06b6d4; color: #67e8f9;
        }
        #upl-test {
          bottom: 150px;
          background: #0f172a; border-color: #fbbf24; color: #fcd34d;
        }
        #upl-stop {
          bottom: 120px;
          background: #0f172a; border-color: #dc2626; color: #f87171;
        }
        #upl-status {
          position: fixed; bottom: 90px; left: 16px; z-index: 2147483647;
          padding: 6px 12px; border-radius: 6px; font-size: 11px;
          font-family: monospace; font-weight: 600;
          background: #1e1b4b; border: 1px solid #06b6d4; color: #67e8f9;
          pointer-events: none; opacity: 0; transition: opacity 0.3s;
          max-width: 320px;
        }
      </style>
      <button class="btn" id="upl-start">UPLOAD vse</button>
      <button class="btn" id="upl-test">TEST 3 songy</button>
      <button class="btn" id="upl-stop">STOP</button>
      <div id="upl-status"></div>
    `;
    shadow.getElementById('upl-start').addEventListener('click', () => startUpload(0));
    shadow.getElementById('upl-test').addEventListener('click', () => startUpload(3));
    shadow.getElementById('upl-stop').addEventListener('click', stopUpload);
  }

  function showStatus(msg, color = '#67e8f9') {
    if (!shadow) return;
    const el = shadow.getElementById('upl-status');
    if (!el) return;
    el.textContent = msg;
    el.style.color = color;
    el.style.borderColor = color;
    el.style.opacity = '1';
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { el.style.opacity = '0'; }, 10000);
  }

  // ── Init: auto-resume if RUNNING flag is set ──────────────────────────────
  function init() {
    buildUI();
    const isRunning = GM_getValue(RUNNING_KEY, '') === '1';
    if (isRunning) {
      const count = parseInt(GM_getValue(COUNT_KEY, '0')) || 0;
      const maxLimit = parseInt(GM_getValue(MAX_LIMIT_KEY, '0')) || 0;
      showStatus(`obnovuji [${count}${maxLimit ? '/' + maxLimit : ''}]`, '#a78bfa');
      setTimeout(runLoop, STEP_DELAY_MS);
    } else {
      showStatus('pripraveno', '#a78bfa');
    }

    setInterval(() => {
      if (!document.getElementById('lg13-suno-uploader-host')) {
        shadow = null;
        buildUI();
      }
    }, 3000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
