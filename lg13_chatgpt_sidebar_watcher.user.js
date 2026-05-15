// ==UserScript==
// @name         LG13 ChatGPT Sidebar Watcher
// @namespace    lg13
// @version      2.0.0
// @description  Project heartbeat — navigates 6 ChatGPT project pages, detects thread changes, triggers ingest
// @author       LG13-coder
// @match        https://chatgpt.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      127.0.0.1
// @updateURL    https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/main/lg13_chatgpt_sidebar_watcher.user.js
// @downloadURL  https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/main/lg13_chatgpt_sidebar_watcher.user.js
// ==/UserScript==

(function () {
  'use strict';

  const LOG = (...a) => console.log('[LG13-SW]', ...a);
  const PL = 'http://127.0.0.1:8790/pl/sidebar/update';
  const STATE_KEY = 'lg13_sw_state';
  const MAX_ROUND = 10;
  const PRIORITY_PROJECTS = ['legal', 'coding'];
  const PRIORITY_MAX_IDLE_MS = 15 * 60 * 1000; // 15 min

  const PROJECTS = [
    { name: 'legal',    url: 'https://chatgpt.com/g/g-p-69f996244ab481918ba51e81400ec15d-legal/project' },
    { name: 'coding',  url: 'https://chatgpt.com/g/g-p-69fffa00a84881918b807aa15cac970e-coding/project' },
    { name: 'lg13',    url: 'https://chatgpt.com/g/g-p-69fa59983680819191f0d6d8fab19840-lg13/project' },
    { name: 'lukys',   url: 'https://chatgpt.com/g/g-p-69df1771b32c8191b039b2706b8bbf2b-lukys-game-13/project' },
    { name: 'business',url: 'https://chatgpt.com/g/g-p-6a0471b795b8819186b2018ac9b5ff6b-ai-business/project' },
    { name: 'siko',    url: 'https://chatgpt.com/g/g-p-6a017f173d288191beec3ea614f1241e-siko/project' },
  ];

  // --- State ---
  function loadState() {
    try { return JSON.parse(localStorage.getItem(STATE_KEY) || 'null') || defaultState(); }
    catch { return defaultState(); }
  }
  function saveState(s) {
    try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch {}
  }
  function defaultState() {
    return { round: 1, proj_idx: 0, last_visit: {}, thread_table: {}, last_change_ts: '' };
  }

  // --- Thread table scraping ---
  function scrapeThreadTable(projectName) {
    const links = [...document.querySelectorAll('a[href*="/c/"]')];
    const seen = new Set();
    const threads = [];
    for (const el of links) {
      const href = el.getAttribute('href') || '';
      const m = href.match(/\/c\/([a-f0-9-]{36})/);
      if (!m) continue;
      const conv_id = m[1];
      if (seen.has(conv_id)) continue;
      seen.add(conv_id);
      const title = (el.textContent || '').trim().slice(0, 80);
      // try to get last message preview from sibling/parent
      const parent = el.closest('li,div[class]');
      const preview = parent ? (parent.textContent || '').replace(title, '').trim().slice(0, 100) : '';
      threads.push({
        conv_id,
        title,
        preview,
        url: 'https://chatgpt.com' + href,
        project: projectName,
        scraped_at: new Date().toISOString(),
      });
    }
    return threads;
  }

  // --- Detect changes ---
  function detectChanges(projectName, newThreads, state) {
    const old = state.thread_table[projectName] || [];
    const oldMap = Object.fromEntries(old.map(t => [t.conv_id, t]));
    const changed = [];
    for (const t of newThreads) {
      const prev = oldMap[t.conv_id];
      if (!prev) {
        changed.push({ ...t, change_type: 'new_thread' });
      } else if (prev.preview !== t.preview || prev.title !== t.title) {
        // estimate thread length — if we can't tell, assume long (total load)
        const load_mode = 'total'; // always total load on change (Tom: "kdyz je vlakno dlouhe, musi ingest pustit total load")
        changed.push({ ...t, change_type: 'updated', load_mode });
      }
    }
    return changed;
  }

  // --- POST to pl_server ---
  function postToPlServer(project, changedThreads, fullTable, callback) {
    const payload = JSON.stringify({
      project,
      changed_threads: changedThreads,
      full_table: fullTable,
      ts: new Date().toISOString(),
    });
    function tryFetch() {
      fetch(PL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      }).then(r => r.json()).then(d => { LOG('POST ok', project, d); callback && callback(true); })
        .catch(e => { LOG('POST fetch err', e); callback && callback(false); });
    }
    try {
      GM_xmlhttpRequest({
        method: 'POST', url: PL,
        headers: { 'Content-Type': 'application/json' },
        data: payload,
        timeout: 8000,
        onload: (r) => { LOG('POST GM ok', project, r.status); callback && callback(true); },
        onerror: () => tryFetch(),
        ontimeout: () => tryFetch(),
      });
    } catch { tryFetch(); }
  }

  // --- Main loop tick ---
  let _ticker = null;

  function tick() {
    const state = loadState();
    const now = Date.now();

    // Check priority projects idle
    for (const pname of PRIORITY_PROJECTS) {
      const last = state.last_visit[pname] ? new Date(state.last_visit[pname]).getTime() : 0;
      if (now - last > PRIORITY_MAX_IDLE_MS) {
        LOG(`Priority idle: ${pname}, visiting now`);
        visitProject(pname, () => scheduleNext(state));
        return;
      }
    }

    // Normal round
    const proj = PROJECTS[state.proj_idx % PROJECTS.length];
    visitProject(proj.name, (changed) => {
      const s = loadState();
      if (changed && changed.length > 0) {
        s.round = 1; // reset round on change
        s.last_change_ts = new Date().toISOString();
        LOG(`Change detected in ${proj.name}, reset to round 1`);
      }
      s.proj_idx = (s.proj_idx + 1) % PROJECTS.length;
      // advance round after full cycle
      if (s.proj_idx === 0) {
        s.round = Math.min(s.round + 1, MAX_ROUND);
        LOG(`Round advanced to ${s.round}`);
      }
      saveState(s);
      scheduleNext(s);
    });
  }

  function scheduleNext(state) {
    const delayMs = state.round * 60 * 1000;
    LOG(`Next visit in ${state.round}min`);
    _ticker = setTimeout(tick, delayMs);
  }

  function visitProject(projectName, callback) {
    const proj = PROJECTS.find(p => p.name === projectName);
    if (!proj) { callback && callback([]); return; }

    LOG(`Visiting project: ${projectName}`);
    const state = loadState();
    state.last_visit[projectName] = new Date().toISOString();
    saveState(state);

    // Navigate to project page
    const prevUrl = location.href;
    history.pushState({}, '', proj.url);
    window.dispatchEvent(new PopStateEvent('popstate'));

    // Wait for content to load
    setTimeout(() => {
      const threads = scrapeThreadTable(projectName);
      LOG(`Scraped ${threads.length} threads from ${projectName}`);

      const s = loadState();
      const changed = detectChanges(projectName, threads, s);

      if (changed.length > 0) {
        LOG(`Changes in ${projectName}:`, changed.length);
        postToPlServer(projectName, changed, threads, () => {
          s.thread_table[projectName] = threads;
          saveState(s);
          // restore prev URL
          history.pushState({}, '', prevUrl);
          window.dispatchEvent(new PopStateEvent('popstate'));
          callback && callback(changed);
        });
      } else {
        s.thread_table[projectName] = threads;
        saveState(s);
        history.pushState({}, '', prevUrl);
        window.dispatchEvent(new PopStateEvent('popstate'));
        callback && callback([]);
      }
    }, 4000); // wait 4s for React render
  }

  // --- Init ---
  function init() {
    LOG('v2.0.0 init — project heartbeat active');
    // Start first tick after 10s delay
    setTimeout(tick, 10000);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    init();
  } else {
    document.addEventListener('DOMContentLoaded', init);
  }
})();
