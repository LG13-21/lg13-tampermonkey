// ==UserScript==
// @name         ChatGPT Adaptive Reload
// @namespace    local.chatgpt
// @version      1.1
// @description  Adaptive page reload — patched MIN_INTERVAL 2min->30min (anti-spam)
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        none
// ==/UserScript==

// PATCH v1.1 (coder, 2026-05-09):
//   MIN_INTERVAL 2*60_000 -> 30*60_000 — combined with LG13 v4.7 ingest
//   2-min reload caused N matching tabs x 30 reloads/h x M atoms = exponential
//   spam (chained with Sidebar Watcher). 30-min floor prevents self-DDOS even
//   without server-side pl_classifier dedup.

(function () {
'use strict';

const MIN_INTERVAL = 30 * 60 * 1000;     // PATCHED: 2 min -> 30 min
const MAX_INTERVAL = 60 * 60 * 1000;     // 1 h
const STEP = 60 * 1000;                  // +1 min
const HARD_STOP_AFTER = 5;               // po 5 refreshech na max stop

let currentInterval = MIN_INTERVAL;
let lastMessageCount = 0;
let idleMaxHits = 0;

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
        console.log('[AdaptiveReload] activity detected');

        lastMessageCount = count;
        currentInterval = MIN_INTERVAL;
        idleMaxHits = 0;

    } else {

        currentInterval = Math.min(
            currentInterval + STEP,
            MAX_INTERVAL
        );

        console.log(
            '[AdaptiveReload] idle, next interval:',
            currentInterval / 1000,
            'sec'
        );

        if (currentInterval >= MAX_INTERVAL) {
            idleMaxHits++;

            if (idleMaxHits >= HARD_STOP_AFTER) {
                console.log('[AdaptiveReload] stopped');
                return;
            }
        }
    }

    console.log('[AdaptiveReload] reload');
    location.reload();
}

function scheduleNext() {
    setTimeout(tick, currentInterval);
}

lastMessageCount = getMessageCount();

console.log('[AdaptiveReload v1.1] started — MIN_INTERVAL=30min (anti-spam)');

scheduleNext();

})();
