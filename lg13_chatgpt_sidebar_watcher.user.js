// ==UserScript==
// @name         ChatGPT Sidebar Watcher
// @namespace    local.chatgpt
// @version      1.5
// @description  Watch ChatGPT conversations (incl. projects) for keywords; backend API primary + DOM fallback [v1.5: backend API across all projects]
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_notification
// @updateURL    https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/coder/anti-spam-2026-05-09/lg13_chatgpt_sidebar_watcher.user.js
// @downloadURL  https://raw.githubusercontent.com/LG13-21/lg13-tampermonkey/coder/anti-spam-2026-05-09/lg13_chatgpt_sidebar_watcher.user.js
// ==/UserScript==

// PATCH v1.5 (coder, 2026-05-11):
//   Backend API `/backend-api/conversations?order=updated&limit=200` primary —
//   vidí konverzace ze VŠECH projektů (Legal/Coding/LG13/...) i když jsou v
//   sidebaru collapsed. DOM scan `a[href*="/c/"]` zůstává jako fallback pokud
//   API rate-limits nebo vrátí non-2xx. Interval bumped 5s -> 15s (API call cost).

// PATCH v1.2 (coder, 2026-05-11):
//   Keywords match F-cycle regex (F\d+) místo hard-coded 'F15'.

// PATCH v1.1 (coder, 2026-05-09):
//   `seen` Set -> localStorage-backed — survives page reloads (Adaptive Reload
//   triggers reload every 30min). localStorage shared across same-origin tabs/reloads.

(function () {
'use strict';

const CHECK_INTERVAL = 15000;
const API_LIMIT = 200;
const SEEN_KEY = 'lg13_sidebar_watcher_seen_v1';

// string  -> case-insensitive substring match
// {re:'..'} -> regex match (full RegExp source string)
const WATCH_KEYWORDS = [
    { re: '\\bF\\d+(\\.\\d+)?\\b' },   // F-cycle: F15, F16, F16.1, F17 ...
    'freeze',
    'OSPOD',
    'review',
    'KONEC STOP',                       // STOP ORDER cancel signal
    'Matoušek',                         // Matous case
];

function loadSeen() {
    try {
        const raw = localStorage.getItem(SEEN_KEY);
        return new Set(raw ? JSON.parse(raw) : []);
    } catch (_) {
        return new Set();
    }
}

function saveSeen(seenSet) {
    try {
        localStorage.setItem(SEEN_KEY, JSON.stringify([...seenSet]));
    } catch (_) {}
}

const seen = loadSeen();

async function fetchConvsAPI() {
    try {
        const url = `/backend-api/conversations?offset=0&limit=${API_LIMIT}&order=updated`;
        const r = await fetch(url, {
            credentials: 'include',
            headers: { 'Accept': 'application/json' }
        });
        if (!r.ok) return null;
        const j = await r.json();
        const items = Array.isArray(j.items) ? j.items : [];
        return items.map(c => ({
            title: (c.title || '').trim(),
            href: `https://chatgpt.com/c/${c.id}`,
            source: 'api'
        }));
    } catch (_) {
        return null;
    }
}

function getThreadsDOM() {
    const links = document.querySelectorAll('a[href*="/c/"]');
    return [...links].map(link => ({
        title: link.innerText.trim(),
        href: link.href,
        source: 'dom'
    }));
}

function shouldWatch(title) {
    const lower = title.toLowerCase();
    return WATCH_KEYWORDS.some(k => {
        if (typeof k === 'string') {
            return lower.includes(k.toLowerCase());
        }
        if (k && k.re) {
            try {
                return new RegExp(k.re, 'i').test(title);
            } catch (_) {
                return false;
            }
        }
        return false;
    });
}

function openThread(thread) {
    if (seen.has(thread.href)) return;
    seen.add(thread.href);
    saveSeen(seen);

    console.log('[Watcher]', thread.source, 'opening:', thread.title);
    window.open(thread.href, '_blank');

    if (typeof GM_notification !== 'undefined') {
        GM_notification({
            title: 'ChatGPT Watcher',
            text: thread.title,
            timeout: 4000
        });
    }
}

async function scan() {
    let threads = await fetchConvsAPI();
    if (!threads) {
        threads = getThreadsDOM();
    }
    threads.forEach(thread => {
        if (!thread.title) return;
        if (shouldWatch(thread.title)) {
            openThread(thread);
        }
    });
}

console.log('[Watcher v1.5] started — seen=' + seen.size + ' (localStorage), keywords=' + WATCH_KEYWORDS.length + ', interval=' + CHECK_INTERVAL + 'ms');
setInterval(scan, CHECK_INTERVAL);
scan();  // initial run on load

})();
