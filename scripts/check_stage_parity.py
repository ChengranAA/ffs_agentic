#!/usr/bin/env python3
"""Check that a generated autoproc script's stages match the log's emitted banners.

M1 acceptance: the parsed stage list matches the banners the script actually emits.

Usage::

    .venv/bin/python scripts/check_stage_parity.py \\
        --script work/bids-lite/sub-001/proc_sub-001.sh \\
        --log work/bids-lite/sub-001/proc_sub-001.log

Exit code 0 means parity (stage12 is exempt because its block is a commented banner,
not an ``echo '== stage12'`` line). Prints a JSON report either way.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

SCRIPT_STAGE = re.compile(r"echo '== (stage[0-9a-z]+):\s*(.*?)\s*=='")
SCRIPT_GLM = re.compile(r"stage12:\s*GLM")
LOG_STAGE = re.compile(r"^== (stage[0-9a-z]+):", re.MULTILINE)
FINISHED = re.compile(r"finished after \d+:\d+:\d+ \(\d+s\)")
FAILED = re.compile(r"ffs_autoproc: FAILED")


def planned_stages(script: str) -> list[str]:
    stages: list[str] = []
    for match in SCRIPT_STAGE.finditer(script):
        name = match.group(1)
        if name not in stages:
            stages.append(name)
    if "stage12" not in stages and SCRIPT_GLM.search(script):
        stages.append("stage12")
    return stages


def emitted_stages(log: str) -> list[str]:
    stages: list[str] = []
    for match in LOG_STAGE.finditer(log):
        name = match.group(1)
        if name not in stages:
            stages.append(name)
    return stages


def parity(script_text: str, log_text: str) -> dict:
    planned = planned_stages(script_text)
    emitted = emitted_stages(log_text)
    # stage12 has a commented banner; it is planned but not echoed.
    expected = [name for name in planned if name != "stage12"]
    missing = [name for name in expected if name not in emitted]
    unexpected = [name for name in emitted if name not in planned]
    order_ok = [name for name in emitted if name in expected] == expected
    return {
        "planned": planned,
        "emitted": emitted,
        "missing": missing,
        "unexpected": unexpected,
        "orderOk": order_ok,
        "finished": bool(FINISHED.search(log_text)),
        "failed": bool(FAILED.search(log_text)),
        "ok": not missing and not unexpected and order_ok,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--script", required=True, type=Path)
    parser.add_argument("--log", required=True, type=Path)
    args = parser.parse_args()
    report = parity(args.script.read_text(encoding="utf-8", errors="replace"),
                    args.log.read_text(encoding="utf-8", errors="replace"))
    print(json.dumps(report, indent=2))
    return 0 if report["ok"] and not report["failed"] else 1


if __name__ == "__main__":
    sys.exit(main())
