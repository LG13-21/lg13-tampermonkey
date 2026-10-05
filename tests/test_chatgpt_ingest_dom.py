import re
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SCRIPT = (ROOT / 'lg13_chatgpt_ingest.user.js').read_text(encoding='utf-8')
TURN_SCRIPTS = ['lg13_chatgpt_ingest.user.js', 'lg13_chatgpt_executor.user.js',
                'lg13_chatgpt_full_loader.user.js', 'lg13_chatgpt_adaptive_reload.user.js']
FIX = Path(__file__).parent / 'fixtures'


def block(name, script=SCRIPT):
    m = re.search(rf'// <{name}>(.*?)// </{name}>', script, re.S)
    assert m, f'marker <{name}> v ingest skriptu chybi'
    return m.group(1)


@pytest.fixture(scope='module')
def page():
    sync_api = pytest.importorskip('playwright.sync_api')
    with sync_api.sync_playwright() as p:
        b = None
        for kw in ({}, {'channel': 'chrome'}, {'channel': 'msedge'}):
            try:
                b = p.chromium.launch(**kw)
                break
            except Exception:
                continue
        if b is None:
            pytest.skip('zadny headless chromium/chrome/msedge')
        pg = b.new_page()
        yield pg
        b.close()


def run_turns(page, script=SCRIPT):
    page.add_script_tag(content=block('lg13-turns', script) + '; window.lg13GetTurns = lg13GetTurns;')
    return page.evaluate('lg13GetTurns(document).map(t => ({role: t.role, msgId: t.msgId, text: t.el.textContent.trim()}))')


def turns(page, fixture, script=SCRIPT):
    page.set_content((FIX / fixture).read_text(encoding='utf-8'))
    return run_turns(page, script)


def test_new_dom_turns_roles_ids_and_clean_text(page):
    got = turns(page, 'chatgpt_new_dom.html')
    assert [(t['role'], t['msgId']) for t in got] == [
        ('user', 'u1-0000'), ('assistant', 'a1-0000'), ('user', 'u2-0000'), ('assistant', 'a2-0000')]
    assert 'otazka jedna' in got[0]['text']
    assert 'ChatGPT said' not in got[1]['text']
    assert 'odpoved jedna' in got[1]['text']


def test_old_dom_still_supported(page):
    got = turns(page, 'chatgpt_old_dom.html')
    assert [(t['role'], t['msgId']) for t in got] == [('user', 'ou1'), ('assistant', 'oa1')]


def test_empty_page_has_no_turns(page):
    page.set_content('<main><p>nic</p></main>')
    assert run_turns(page) == []


# ---- isAppendOnly (cista logika, node) ----
def append_only(new_ids, prev_ids):
    js = block('lg13-append-only') + f"""
const mk = a => a.map(id => ({{id}}));
process.stdout.write(String(isAppendOnly(mk({new_ids!r}), {prev_ids!r})));"""
    return subprocess.run(['node', '-e', js], capture_output=True, text=True, check=True).stdout == 'true'


def test_append_new_tail_message():
    assert append_only(['a', 'b', 'c'], ['a', 'b'])


def test_nothing_sent_yet_counts_as_append():
    assert append_only(['a'], [])


def test_scroll_up_prepend_without_new_tail_is_skipped():
    assert not append_only(['x', 'y', 'a', 'b'], ['a', 'b'])


def test_prepend_then_new_tail_is_sent():
    assert append_only(['x', 'y', 'a', 'b', 'c'], ['a', 'b'])


def test_switch_to_other_conversation_no_overlap_is_sent():
    assert append_only(['p', 'q'], ['a', 'b'])


def test_last_message_text_changed_after_streaming_is_sent():
    assert append_only(['a', 'b2'], ['a', 'b'])


def test_identical_window_is_not_append():
    assert not append_only(['a', 'b'], ['a', 'b'])


@pytest.mark.parametrize('name', TURN_SCRIPTS)
def test_all_chatgpt_scripts_share_identical_turn_helper(name):
    s = (ROOT / name).read_text(encoding='utf-8')
    assert block('lg13-turns', s) == block('lg13-turns')


@pytest.mark.parametrize('name', ['lg13_chatgpt_executor.user.js', 'lg13_chatgpt_full_loader.user.js',
                                  'lg13_chatgpt_adaptive_reload.user.js'])
def test_no_script_relies_only_on_old_selector_outside_helper(name):
    s = (ROOT / name).read_text(encoding='utf-8')
    outside = re.sub(r'// <lg13-turns>.*?// </lg13-turns>', '', s, flags=re.S)
    assert "querySelectorAll('[data-message-author-role]')" not in outside
