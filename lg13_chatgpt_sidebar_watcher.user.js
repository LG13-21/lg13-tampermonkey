// ==UserScript==
// @name         ChatGPT Sidebar Watcher
// @namespace    local.chatgpt
// @version      1.3
// @description  Watch sidebar for keywords (regex + literal), open matching threads — localStorage seen + F-cycle regex [v1.3: pl_server proxy]
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_notification
// @updateURL    http://127.0.0.1:8790/pl/tmonkey/lg13_chatgpt_sidebar_watcher.user.js
// @downloadURL  http://127.0.0.1:8790/pl/tmonkey/lg13_chatgpt_sidebar_watcher.user.js
// ==/UserScript==

// PATCH v1.2 (coder, 2026-05-11):
//   Keywords match F-cycle regex (F\d+) místo hard-coded 'F15'.
//   Tom je teď na F16+, takže F15 už nic neotvíralo. Regex chytá F1..F99
//   automaticky — nikdy nepoužitelný refresh když přijde F17/F18 atd.
//   Plus: keywords mohou být objekty {re: '...'} pro custom regex.

// PATCH v1.1 (coder, 2026-05-09):
//   `seen` Set -> localStorage-backed — survives page reloads (Adaptive Reload
//   triggers reload every 30min). Without persistence, after each reload Set
//   is empty -> all matching threads re-open as new tabs -> tab fork-bomb.
//   localStorage shared across same-origin tabs/reloads.

(function () {
'use strict';

const CHECK_INTERVAL = 5000;
const SEEN_KEY = 'lg13_sidebar_watcher_seen_v1';

// Můžeš mít:
//   string  -> case-insensitive substring match
//   {re:'..'} -> regex match (full RegExp source string)
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

function getThreads() {
    const links = document.querySelectorAll('a[href*="/c/"]');
    return [...links].map(link => ({
        title: link.innerText.trim(),
        href: link.href
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
    if (seen.has(thread.href)) {
        return;
    }
    seen.add(thread.href);
    saveSeen(seen);

    console.log('[Watcher] opening:', thread.title);
    window.open(thread.href, '_blank');

    if (typeof GM_notification !== 'undefined') {
        GM_notification({
            title: 'ChatGPT Watcher',
            text: thread.title,
            timeout: 4000
        });
    }
}

function scan() {
    const threads = getThreads();
    threads.forEach(thread => {
        if (!thread.title) return;
        if (shouldWatch(thread.title)) {
            openThread(thread);
        }
    });
}

console.log('[Watcher v1.2] started — seen=' + seen.size + ' (localStorage), keywords=' + WATCH_KEYWORDS.length);
setInterval(scan, CHECK_INTERVAL);

})();
