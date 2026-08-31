#!/usr/bin/env python
"""cge_search — full-text search across ChatGPT JSON exports (CGE) and/or atom daily store.
USE THIS instead of ad-hoc one-off Python for searching ChatGPT_export/*.json or atoms/daily/*.json.
"""
import sys
sys.stdout.reconfigure(encoding='utf-8')

import argparse
import json
import re
import time
from datetime import datetime, timezone
from pathlib import Path

TELEMETRY_FILE = Path("L:/LG13/runtime/logs/action_telemetry.jsonl")
CGE_DEFAULT = Path("L:/GitHub/legal-ship-2026/ChatGPT_export")
ATOMS_DEFAULT = Path("L:/LG13/atoms/daily")
MAX_RESULTS = 100


def log_telemetry(instance: str, action: str, tokens_est: int, success: bool, extra: dict = None):
    TELEMETRY_FILE.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "ts": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "instance": instance,
        "action": action,
        "category": "search",
        "est_tokens": tokens_est,
        "success": success,
    }
    if extra:
        entry.update(extra)
    with open(TELEMETRY_FILE, 'a', encoding='utf-8') as f:
        f.write(json.dumps(entry, ensure_ascii=False) + '\n')


def conv_id_from_link(link: str) -> str:
    return link.rstrip('/').split('/')[-1] if link else ''


def search_cge(cge_dir: Path, query_re, conv_id: str, limit_files: int, limit_hits: int):
    """messages-format export: {"metadata": {...}, "messages": [{"role","say","time"}]}.
    Non-conversation JSON in this folder (review matrices, verdict extracts) lacks a
    top-level "messages" key and is skipped rather than raising.
    """
    hits = []
    files = sorted(cge_dir.glob('*.json'), key=lambda f: f.stat().st_mtime, reverse=True)
    if limit_files:
        files = files[:limit_files]
    for f in files:
        if len(hits) >= limit_hits:
            break
        try:
            data = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        if not isinstance(data, dict) or 'messages' not in data:
            continue
        meta = data.get('metadata', {})
        this_conv_id = conv_id_from_link(meta.get('link', ''))
        if conv_id and conv_id not in this_conv_id and conv_id not in f.name:
            continue
        for i, m in enumerate(data.get('messages', [])):
            say = m.get('say', '') or ''
            if query_re.search(say) or (not query_re.pattern and conv_id):
                hits.append({
                    'file': f.name, 'conv_id': this_conv_id, 'title': meta.get('title', ''),
                    'role': m.get('role', '?'), 'time': m.get('time', ''),
                    'idx': i, 'snippet': say[:300],
                })
                if len(hits) >= limit_hits:
                    break
    return hits


def search_atoms(atoms_dir: Path, query_re, conv_id: str, limit_files: int, limit_hits: int):
    """atom daily store: L:/LG13/atoms/daily/YYYY-MM-DD.json — top-level list of atom dicts.
    Text lives in lg13_meta.lg13_ctx (atom summary), not a plain "content" field.
    """
    hits = []
    files = sorted(atoms_dir.glob('*.json'), reverse=True)  # filename = date -> newest first
    if limit_files:
        files = files[:limit_files]
    for f in files:
        if len(hits) >= limit_hits:
            break
        try:
            data = json.loads(f.read_text(encoding='utf-8'))
        except Exception:
            continue
        atoms = data if isinstance(data, list) else data.get('atoms', [])
        for a in atoms:
            aid = a.get('atom_id') or a.get('id') or ''
            acid = a.get('conv_id', '')
            if conv_id and conv_id not in acid and conv_id not in aid:
                continue
            ctx = (a.get('lg13_meta', {}) or {}).get('lg13_ctx', '') or a.get('text', '') or ''
            title = a.get('conv_title', '')
            if query_re.search(ctx) or query_re.search(title) or (not query_re.pattern and conv_id):
                hits.append({
                    'file': f.name, 'atom_id': aid, 'conv_id': acid,
                    'conv_title': title, 'ctx': ctx[:300],
                })
                if len(hits) >= limit_hits:
                    break
    return hits


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--query', default='', help='substring to search for (case-insensitive, literal — not regex)')
    ap.add_argument('--conv-id', default='', help='filter by conv_id substring (from chatgpt.com/c/<conv_id>)')
    ap.add_argument('--source', choices=['cge', 'atoms', 'both'], default='both')
    ap.add_argument('--cge-dir', default=str(CGE_DEFAULT))
    ap.add_argument('--atoms-dir', default=str(ATOMS_DEFAULT))
    ap.add_argument('--limit-files', type=int, default=0, help='cap files scanned per source, newest first (0=all)')
    ap.add_argument('--limit-hits', type=int, default=MAX_RESULTS)
    ap.add_argument('--instance', default='coder', help='for telemetry logging')
    args = ap.parse_args()

    if not args.query and not args.conv_id:
        print('ERROR: zadej --query nebo --conv-id', file=sys.stderr)
        sys.exit(1)

    query_re = re.compile(re.escape(args.query), re.IGNORECASE)
    limit_hits = min(args.limit_hits, MAX_RESULTS)

    t0 = time.time()
    all_hits = []
    if args.source in ('cge', 'both'):
        cge_dir = Path(args.cge_dir)
        if not cge_dir.exists():
            print(f'ERROR: CGE dir neexistuje: {cge_dir}', file=sys.stderr)
        else:
            all_hits += [('cge', h) for h in search_cge(cge_dir, query_re, args.conv_id, args.limit_files, limit_hits)]
    if args.source in ('atoms', 'both') and len(all_hits) < limit_hits:
        atoms_dir = Path(args.atoms_dir)
        if not atoms_dir.exists():
            print(f'ERROR: atoms dir neexistuje: {atoms_dir}', file=sys.stderr)
        else:
            all_hits += [('atoms', h) for h in search_atoms(atoms_dir, query_re, args.conv_id, args.limit_files, limit_hits - len(all_hits))]

    all_hits = all_hits[:limit_hits]
    print(f"=== {len(all_hits)} hits (source={args.source}, query={args.query!r}, conv_id={args.conv_id!r}) ===")
    for src, h in all_hits:
        if src == 'cge':
            print(f"[CGE] {h['file']} | {h['title']} | conv_id={h['conv_id']} | [{h['role']} {h['time']}]")
            print(f"      {h['snippet']}")
        else:
            print(f"[ATOM] {h['file']} | {h['conv_title']} | atom_id={h['atom_id']}")
            print(f"      {h['ctx']}")
        print()

    log_telemetry(args.instance, 'cge_search', tokens_est=len(all_hits) * 60, success=True,
                  extra={'query': args.query, 'conv_id': args.conv_id, 'source': args.source,
                         'hits': len(all_hits), 'duration_s': round(time.time() - t0, 2)})


if __name__ == '__main__':
    main()
