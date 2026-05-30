#!/usr/bin/env python3
"""
image_catalog.py — katalogizuje všechny obrázky v repozitáři s OCR přepisem

Výstup: artifacts/image_catalog.json + artifacts/image_catalog.csv

Spuštění:
    python scripts/image_catalog.py [--repo-root .] [--output artifacts] [--csv]

Závislosti (nepovinné):
    pip install pillow pytesseract
    + Tesseract OCR: https://github.com/UB-Mannheim/tesseract/wiki
"""
from __future__ import annotations

import csv
import json
import mimetypes
import os
import sys
from datetime import datetime
from pathlib import Path

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tiff", ".tif", ".svg"}
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".claude", "artifacts"}

try:
    from PIL import Image
    PIL_OK = True
except ImportError:
    PIL_OK = False

try:
    import pytesseract
    OCR_OK = True
except ImportError:
    OCR_OK = False


def get_context(path: Path, repo_root: Path) -> str:
    rel = path.relative_to(repo_root)
    parts = list(rel.parts[:-1])
    return "/".join(parts) if parts else "(root)"


def ocr_image(path: Path) -> str:
    if not PIL_OK or not OCR_OK:
        return ""
    try:
        img = Image.open(path).convert("RGB")
        text = pytesseract.image_to_string(img, lang="ces+eng", config="--psm 3")
        return text.strip()[:2000]
    except Exception as e:
        return f"[OCR error: {e}]"


def file_dates(path: Path) -> tuple[str, str]:
    try:
        stat = path.stat()
        created = datetime.fromtimestamp(stat.st_ctime).isoformat(timespec="seconds")
        modified = datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds")
        return created, modified
    except Exception:
        return "", ""


def guess_topic(path: Path) -> str:
    rel_str = str(path).lower()
    if any(x in rel_str for x in ("exhibit", "priloha", "attachment")):
        return "exhibit/attachment"
    if any(x in rel_str for x in ("screenshot", "snimek", "screen")):
        return "screenshot"
    if any(x in rel_str for x in ("pdf", "render", "output")):
        return "rendered output"
    if any(x in rel_str for x in ("timeline", "diagram", "chart", "schema")):
        return "diagram/timeline"
    if any(x in rel_str for x in ("logo", "icon", "badge")):
        return "logo/icon"
    return "other"


def scan_repo(repo_root: Path, output_dir: Path, write_csv: bool = False) -> list[dict]:
    catalog = []
    print(f"[image_catalog] Scan: {repo_root}")

    for root, dirs, files in os.walk(repo_root):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fname in files:
            path = Path(root) / fname
            if path.suffix.lower() not in IMAGE_EXTENSIONS:
                continue
            rel = path.relative_to(repo_root)
            created, modified = file_dates(path)
            try:
                size = path.stat().st_size
            except Exception:
                size = 0
            ocr_text = ocr_image(path)
            entry = {
                "path": str(rel).replace("\\", "/"),
                "filename": fname,
                "directory": get_context(path, repo_root),
                "extension": path.suffix.lower(),
                "size_bytes": size,
                "created": created,
                "modified": modified,
                "topic": guess_topic(path),
                "ocr_text": ocr_text,
                "ocr_available": OCR_OK and PIL_OK,
            }
            catalog.append(entry)
            status = f"OCR:{len(ocr_text)}ch" if ocr_text else "no-OCR"
            print(f"  [{status}] {rel}")

    output_dir.mkdir(parents=True, exist_ok=True)

    json_out = output_dir / "image_catalog.json"
    json_out.write_text(json.dumps(catalog, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[image_catalog] JSON: {json_out} ({len(catalog)} obrazku)")

    if write_csv:
        csv_out = output_dir / "image_catalog.csv"
        fields = ["path", "filename", "directory", "extension", "size_bytes", "created", "modified", "topic", "ocr_text"]
        with open(csv_out, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
            w.writeheader()
            w.writerows(catalog)
        print(f"[image_catalog] CSV: {csv_out}")

    return catalog


def main():
    import argparse
    ap = argparse.ArgumentParser(description="Katalogizuje obrázky v repo s OCR přepisem")
    ap.add_argument("--repo-root", default=".", help="Kořen repozitáře (default: .)")
    ap.add_argument("--output", default="artifacts", help="Výstupní adresář (default: artifacts)")
    ap.add_argument("--csv", action="store_true", help="Generuj také CSV výstup")
    args = ap.parse_args()

    repo_root = Path(args.repo_root).resolve()
    output_dir = Path(args.output) if Path(args.output).is_absolute() else repo_root / args.output

    if not PIL_OK:
        print("[image_catalog] ⚠ Pillow nedostupný — pip install pillow (OCR disabled)")
    if not OCR_OK:
        print("[image_catalog] ⚠ pytesseract nedostupný — pip install pytesseract (OCR disabled)")

    catalog = scan_repo(repo_root, output_dir, write_csv=args.csv)
    print(f"[image_catalog] Hotovo: {len(catalog)} obrázků")


if __name__ == "__main__":
    main()
