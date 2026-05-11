// ==UserScript==
// @name         ChatGPT Adaptive Reload
// @namespace    local.chatgpt
// @version      1.2
// @description  Adaptive page reload — reload jen v idle, no hard-stop, MIN 5 min
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        none
// ==/UserScript==

// PATCH v1.2 (coder, 2026-05-11):
//   3 fixes proti v1.1:
//   1. ACTIVITY branch NEREloaduje — page už ukazuje nové zprávy z DOM update,
//      zbytečný reload (a window listenery se ztratí + state reset).
//   2. HARD_STOP_AFTER odstraněno — script umíral po pár hodinách idle,
//      Tom přišel po obědě a stránka byla zaseknutá. Místo toho clamp na MAX.
//   3. MIN_INTERVAL 30min -> 5min — 30min byl moc velký anti-spam overshoot,
//      Tom dostává zprávy častěji než 30min. Server-side dedup v pl_classifier
//      už drží DDOS pod kontrolou (ingest v4.7 atom dedup).
//   Plus defensive: scheduleNext() volaný i v idle větvi pro robustnost.

// PATCH v1.1 (coder, 2026-05-09):
//   MIN_INTERVAL 2*60_000 -> 30*60_000 — combined with LG13 v4.7 ingest
//   2-min reload caused N matching tabs x 30 reloads/h x M atoms = exponential
//   spam (chained with Sidebar Watcher). 30-min floor prevents self-DDOS even
//   without server-side pl_classifier dedup.

(function () {
'use strict';

const MIN_INTERVAL = 5 * 60 * 1000;      // PATCHED v1.2: 30 min -> 5 min
const MAX_INTERVAL = 60 * 60 * 1000;     // 1 h
const STEP = 60 * 1000;                  // +1 min per idle tick

let currentInterval = MIN_INTERVAL;
let lastMessageCount = 0;

function getMessageCount() {
    return document.querySelectorAll('[data-message-author-role]').length;
}

function isGenerating() {
    return !!document.querySelector('[data-testid="stop-button"]');
}

function isTyping() {
    const el = document.activeElement;
    return el &&
           (el.tagName === 'TEXTAREA' ||
            el.tagName === 'INPUT' ||
            el.isContentEditable);
}

function tick() {

    if (isGenerating()) {
        console.log('[AdaptiveReload] generating, skip');
        scheduleNext();
        return;
    }

    if (isTyping()) {
        console.log('[AdaptiveReload] typing, skip');
        scheduleNext();
        return;
    }

    const count = getMessageCount();

    if (count > lastMessageCount) {
        // ACTIVITY: page already shows new messages via DOM update.
        // Reload would just reset state. Reset interval and wait.
        console.log('[AdaptiveReload] activity detected (' + lastMessageCount + ' -> ' + count + '), no reload');
        lastMessageCount = count;
        currentInterval = MIN_INTERVAL;
        scheduleNext();
        return;
    }

    // IDLE: bump interval (clamped at MAX), then reload.
    currentInterval = Math.min(currentInterval + STEP, MAX_INTERVAL);
    console.log(
        '[AdaptiveReload] idle reload, next interval:',
        currentInterval / 1000,
        'sec'
    );
    location.reload();
}

function scheduleNext() {
    setTimeout(tick, currentInterval);
}

lastMessageCount = getMessageCount();

console.log('[AdaptiveReload v1.2] started — MIN_INTERVAL=5min, no hard-stop, baseline count=' + lastMessageCount);

scheduleNext();

})();
