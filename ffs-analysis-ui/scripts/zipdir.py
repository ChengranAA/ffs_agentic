#!/usr/bin/env python3
"""Zip a package directory deterministically.

Usage::

    .venv/bin/python scripts/zipdir.py <package-dir> <out.zip>
"""

from __future__ import annotations

import sys
import zipfile
from pathlib import Path


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: zipdir.py <dir> <zip>", file=sys.stderr)
        return 2
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    if not src.is_dir():
        print(f"not a directory: {src}", file=sys.stderr)
        return 1
    with zipfile.ZipFile(out, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(src.rglob("*")):
            if not path.is_file():
                continue
            info = zipfile.ZipInfo(str(path.relative_to(src)))
            info.date_time = (1980, 1, 1, 0, 0, 0)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o755 if path.name.endswith((".sh", ".py")) else 0o644) << 16
            archive.writestr(info, path.read_bytes())
    print(out)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
