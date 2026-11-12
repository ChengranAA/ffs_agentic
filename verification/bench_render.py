#!/usr/bin/env python3
"""Measure the FFS Harness viewer rendering prototype, end to end.

This is the reproducibility script for ``docs/RENDERING_EVALUATION.md``. It drives
the *real* Python sidecar exactly as the Host does -- spawned with
``python -m ffsviewer.server`` and spoken to in newline-delimited JSON -- and records
latencies and wire-payload sizes for every rendering endpoint the browser uses:

  * ``render``  (slice PNGs + surface outlines), cold and warm, at several
    crosshairs, zooms and thresholds for V1/V2/V3
  * ``state``   (the 350 ms poll payload)
  * ``execute`` / ``pick`` / ``pan`` / ``zoom`` / ``step`` (interaction round trips)
  * ``surface`` (full world-space mesh vs colours-only), depth samples 1/5/9
  * ``surface_pick`` (server-authoritative ray pick)
  * ``series``  (graph windows at grid 1/2/4/8/16, 80 time points)

It also estimates the client side: a Node/V8 script (no browser required) measures
JSON parse, base64 decode, PNG inflate/unfilter, outline decode and the client's
own ``vertexNormals`` loop over the real payloads. Those are **CPU proxies**, not
browser frame timings: this checkout has no browser automation, so canvas/WebGL
GPU time cannot be measured here.

Run from the repository root:

    .venv/bin/python verification/bench_render.py            # 36 samples per cell
    .venv/bin/python verification/bench_render.py -n 60      # more samples
    .venv/bin/python verification/bench_render.py --skip-node

The script prints markdown tables and one final ``=== JSON ===`` block with every
summary statistic, so a doc author can quote numbers without re-deriving them.
Nothing is written outside a private temp directory.
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import platform
import shutil
import statistics
import struct
import subprocess
import sys
import tempfile
import time
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
for _p in (str(ROOT / "python"), str(ROOT / "reference" / "fastfuncstuff")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

import numpy as np  # noqa: E402


# --------------------------------------------------------------------------- stats


def percentile(values, q: float):
    """Linear-interpolated percentile; ``q`` in [0, 1]. None for an empty list."""
    vs = sorted(float(v) for v in values)
    if not vs:
        return None
    if len(vs) == 1:
        return vs[0]
    k = (len(vs) - 1) * q
    lo, hi = math.floor(k), math.ceil(k)
    if lo == hi:
        return vs[int(k)]
    return vs[lo] + (vs[hi] - vs[lo]) * (k - lo)


def summarize(values) -> dict:
    vs = [float(v) for v in values]
    if not vs:
        return {"n": 0}
    return {
        "n": len(vs),
        "p50": percentile(vs, 0.50),
        "p95": percentile(vs, 0.95),
        "max": max(vs),
        "mean": statistics.fmean(vs),
        "min": min(vs),
    }


def ms(stats: dict) -> str:
    return f"{stats['p50'] * 1000:.2f} / {stats['p95'] * 1000:.2f} / {stats['max'] * 1000:.2f}"


def kb(n: float) -> str:
    return f"{n / 1000.0:.1f}"


def b64_binary_len(text: str | None) -> int:
    """Bytes represented by a base64 string (the b64 itself is 4/3 larger)."""
    if not text:
        return 0
    pad = len(text) - len(text.rstrip("="))
    return (len(text) // 4) * 3 - pad


def zratio(data: bytes) -> float:
    if not data:
        return 1.0
    return len(zlib.compress(data, 1)) / len(data)


# --------------------------------------------------------------------------- sidecar


class Record:
    __slots__ = ("seconds", "line_bytes", "result_bytes", "result", "ok", "error")

    def __init__(self, seconds, line, result, ok=True, error=None):
        line_bytes = line.encode("utf-8")
        self.seconds = seconds
        self.line_bytes = len(line_bytes)
        self.result = result
        self.ok = ok
        self.error = error
        self.result_bytes = (len(json.dumps(result, separators=(",", ":"))) if result is not None
                              else len(line_bytes))

    @property
    def dt_ms(self) -> float:
        return self.seconds * 1000.0


class Sidecar:
    """A spawned sidecar process, spoken to in the Host's NDJSON protocol."""

    def __init__(self, root: Path, stderr_path: Path):
        self.root = root
        self.stderr_path = stderr_path
        self.proc = None
        self.state_dir = None
        self._id = 0
        self.hello = None

    def __enter__(self) -> "Sidecar":
        import ffsviewer.server  # noqa: F401  (proves the module resolves)

        py = self.root / ".venv" / "bin" / "python"
        self.state_dir = Path(tempfile.mkdtemp(prefix="ffs-render-bench-state-"))
        env = dict(os.environ)
        env["PYTHONPATH"] = f"{self.root / 'python'}:{self.root / 'reference' / 'fastfuncstuff'}"
        self.proc = subprocess.Popen(
            [str(py), "-u", "-m", "ffsviewer.server",
             "--project-root", str(self.root),
             "--state-dir", str(self.state_dir),
             "--no-autosave"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=env,
            text=True,
            bufsize=1,
        )
        rec = self.call("hello")
        self.hello = rec.result
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            if self.proc and self.proc.poll() is None:
                self.call("shutdown", allow_error=True)
        except Exception:
            pass
        try:
            if self.proc and self.proc.poll() is None:
                self.proc.terminate()
                self.proc.wait(timeout=5)
        except Exception:
            pass
        if self.proc:
            self.proc.stdin and self.proc.stdin.close()
            self.proc.stdout and self.proc.stdout.close()
        if self.state_dir:
            shutil.rmtree(self.state_dir, ignore_errors=True)

    def call(self, method: str, params: dict | None = None, *, allow_error: bool = False) -> Record:
        assert self.proc and self.proc.stdin and self.proc.stdout
        self._id += 1
        payload = json.dumps({"id": self._id, "method": method, "params": params or {}})
        t0 = time.perf_counter()
        self.proc.stdin.write(payload + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        dt = time.perf_counter() - t0
        if not line:
            raise RuntimeError(f"sidecar died during {method!r}; check {self.stderr_path}")
        message = json.loads(line)
        if not message.get("ok"):
            if not allow_error:
                raise RuntimeError(f"{method} failed: {message.get('error')}")
            return Record(dt, line, None, ok=False, error=message.get("error"))
        return Record(dt, line, message["result"])

    # -- convenience mutations ------------------------------------------------
    def execute(self, line: str) -> Record:
        return self.call("execute", {"line": line})


# --------------------------------------------------------------------------- png


def decode_png_rgba(data: bytes) -> np.ndarray:
    """Decode the sidecar's own PNG stream (8-bit RGBA, filter 0 scanlines)."""
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    pos, idat = 8, bytearray()
    w = h = 0
    while pos < len(data):
        length = struct.unpack(">I", data[pos:pos + 4])[0]
        tag = data[pos + 4:pos + 8]
        chunk = data[pos + 8:pos + 8 + length]
        pos += 12 + length
        if tag == b"IHDR":
            w, h = struct.unpack(">II", chunk[:8])
        elif tag == b"IDAT":
            idat.extend(chunk)
        elif tag == b"IEND":
            break
    raw = zlib.decompress(bytes(idat))
    stride = w * 4 + 1
    rows = np.frombuffer(raw, np.uint8).reshape(h, stride)
    return rows[:, 1:].reshape(h, w, 4)


# --------------------------------------------------------------------------- node proxy


NODE_SCRIPT = r"""
const fs = require('fs');
const zlib = require('zlib');
const payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));

function percentile(vs, q) {
  const s = [...vs].sort((a, b) => a - b);
  if (!s.length) return null;
  const k = (s.length - 1) * q;
  const lo = Math.floor(k), hi = Math.ceil(k);
  return lo === hi ? s[k] : s[lo] + (s[hi] - s[lo]) * (k - lo);
}

function bench(name, fn, n, warmup = 3) {
  for (let i = 0; i < warmup; i += 1) fn();
  const times = [];
  let bytes = null;
  for (let i = 0; i < n; i += 1) {
    const t0 = performance.now();
    const out = fn();
    times.push(performance.now() - t0);
    if (out != null && typeof out === 'number') bytes = out;
  }
  return { name, n, p50: percentile(times, .5), p95: percentile(times, .95),
           max: Math.max(...times), mean: times.reduce((a, b) => a + b, 0) / times.length,
           bytes };
}

function pngInflate(b64) {
  const buf = Buffer.from(b64, 'base64');
  let pos = 8; const idat = [];
  let w = 0, h = 0;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const tag = buf.toString('ascii', pos + 4, pos + 8);
    if (tag === 'IHDR') { w = buf.readUInt32BE(pos + 8); h = buf.readUInt32BE(pos + 12); }
    else if (tag === 'IDAT') idat.push(buf.subarray(pos + 8, pos + 8 + len));
    else if (tag === 'IEND') break;
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * 4 + 1;
  for (let y = 0; y < h; y += 1) {
    if (raw[y * stride] !== 0) throw new Error('unexpected PNG filter');
  }
  return raw.length;
}

function toB64Bytes(base64) {
  const bin = atob(base64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}
function decodeF32(base64) {
  const bytes = toB64Bytes(base64);
  return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}
function decodeU32(base64) {
  const bytes = toB64Bytes(base64);
  return new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
}
function decodeU8(base64) { return toB64Bytes(base64); }

function vertexNormals(positions, faces) {
  const normals = new Float32Array(positions.length);
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f] * 3, b = faces[f + 1] * 3, c = faces[f + 2] * 3;
    const e1x = positions[b] - positions[a], e1y = positions[b + 1] - positions[a + 1], e1z = positions[b + 2] - positions[a + 2];
    const e2x = positions[c] - positions[a], e2y = positions[c + 1] - positions[a + 1], e2z = positions[c + 2] - positions[a + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    for (const index of [a, b, c]) { normals[index] += nx; normals[index + 1] += ny; normals[index + 2] += nz; }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
    normals[i] /= len; normals[i + 1] /= len; normals[i + 2] /= len;
  }
  return normals;
}

const out = [];
try {
  out.push(bench('json.parse:state', () => JSON.parse(payload.state_json), 300));
  out.push(bench('json.parse:render_result', () => JSON.parse(payload.render_json), 200));
  out.push(bench('json.parse:surface_colors_only', () => JSON.parse(payload.surface_colors_json), 200));
  out.push(bench('json.parse:surface_full_mesh', () => JSON.parse(payload.surface_full_json), 30));
  out.push(bench('json.parse:series_grid4', () => JSON.parse(payload.series_json), 200));
  out.push(bench('b64decode:png', () => Buffer.from(payload.png_b64, 'base64').length, 300));
  out.push(bench('decode:png_inflate_unfilter', () => pngInflate(payload.png_b64), 200));
  out.push(bench('b64decode:outline_f32', () => Buffer.from(payload.outline_b64, 'base64').length, 300));
  out.push(bench('b64decode:surface_colors_u8', () => Buffer.from(payload.colors_b64, 'base64').length, 300));
  out.push(bench('decode:mesh_positions_f32', () => Buffer.from(payload.positions_b64, 'base64').length, 100));
  out.push(bench('decode:mesh_faces_u32', () => Buffer.from(payload.faces_b64, 'base64').length, 100));
  out.push(bench('client:toB64Bytes_png', () => toB64Bytes(payload.png_b64).length, 200));
  out.push(bench('client:decodeF32_outlines', () => decodeF32(payload.outline_b64).length, 200));
  out.push(bench('client:decodeU8_surface_colors', () => decodeU8(payload.colors_b64).length, 200));
  out.push(bench('client:decodeF32_mesh_positions', () => decodeF32(payload.positions_b64).length, 100));
  out.push(bench('client:decodeU32_mesh_faces', () => decodeU32(payload.faces_b64).length, 100));
  out.push(bench('client:decode_mesh_and_vertexNormals_one_hemi', () => {
    const p = decodeF32(payload.positions_b64);
    const f = decodeU32(payload.faces_b64);
    return vertexNormals(p, f).length;
  }, 30));
} catch (err) {
  console.log(JSON.stringify({ error: String(err && err.stack || err), benches: out }));
  process.exit(0);
}
console.log(JSON.stringify({ benches: out, node: process.version }));
"""


def node_proxy(payload: dict, workdir: Path) -> dict:
    node = shutil.which("node")
    if not node:
        return {"available": False, "reason": "node not on PATH"}
    payload_path = workdir / "client_payloads.json"
    script_path = workdir / "client_proxy.js"
    payload_path.write_text(json.dumps(payload))
    script_path.write_text(NODE_SCRIPT)
    proc = subprocess.run([node, str(script_path), str(payload_path)],
                          capture_output=True, text=True, timeout=180)
    if proc.returncode != 0:
        return {"available": False, "reason": proc.stderr[-2000:] or "node failed"}
    return {"available": True, **json.loads(proc.stdout)}


# --------------------------------------------------------------------------- main


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("-n", "--samples", type=int, default=36, help="samples per cell (>=30)")
    ap.add_argument("--skip-node", action="store_true", help="skip the V8 client-CPU proxy")
    args = ap.parse_args(argv)
    if args.samples < 10:
        ap.error("--samples must be at least 10")

    N = args.samples
    report: dict = {
        "environment": {
            "platform": platform.platform(),
            "machine": platform.machine(),
            "python": sys.version.split()[0],
            "numpy": np.__version__,
            "repoRoot": str(ROOT),
            "samples": N,
        },
        "sections": {},
    }

    # Where the browser renders: this is irrelevant to the sidecar but the
    # derived client estimates below need a pane size. See docs/RENDERING_EVALUATION.md.
    PANEL = {"width": 1180, "height": 760, "rail": 238, "head": 40, "foot": 30}
    PANEL["dock"] = PANEL["width"] - PANEL["rail"]
    PANEL["slice_pane_w"] = PANEL["dock"] * 1.25 / 2.25 - 13
    PANEL["canvas_w"] = PANEL["slice_pane_w"] - 10
    PANEL["canvas_h"] = PANEL["height"] - PANEL["head"] - PANEL["foot"] - 18
    report["assumed_default_pane"] = PANEL
    report["client_caveat"] = (
        "No browser automation is available in this checkout. All client costs below are "
        "V8/Node CPU proxies measured on the same machine; browser main-thread frame timing, "
        "canvas drawImage and WebGL raster time are NOT measured."
    )

    stderr_path = Path(tempfile.mkdtemp(prefix="ffs-render-bench-log-")) / "sidecar.err"

    def row(name, stats, extra=""):
        print(f"| {name} | {stats['n']} | {ms(stats)} | {extra} |")

    with Sidecar(ROOT, stderr_path) as sc:
        report["environment"].update({
            "sidecarVersion": sc.hello.get("version"),
            "ffsVersion": sc.hello.get("ffsVersion"),
            "device": sc.hello.get("device"),
            "commands": sc.hello.get("commands"),
        })

        # ------------------------------------------------------------- boot
        print("\n## 0. Boot and open (cold process)")
        print("\n| item | value |")
        print("|---|---|")
        t0 = time.perf_counter()
        opened = sc.call("open", {"preset": "demo"})
        open_s = time.perf_counter() - t0
        state0 = opened.result["state"]
        report["sections"]["boot"] = {
            "openSeconds": open_s,
            "initialStateLineBytes": opened.line_bytes,
            "initialStateResultBytes": opened.result_bytes,
            "preset": opened.result.get("preset"),
            "loading": opened.result.get("loading"),
            "gridShape": state0["grid"]["shape"],
            "maxTimeIndex": state0["maxTimeIndex"],
            "viewports": [(v["id"], v["kind"], v.get("plane")) for v in state0["viewports"]],
            "layers": [{"key": ly["key"], "colormap": ly["colormap"],
                        "threshold": ly["threshold"], "nVolumes": ly["nVolumes"]}
                       for ly in state0["layers"]],
        }
        print(f"| open preset demo | {open_s * 1000:.0f} ms |")
        print(f"| initial snapshot | {kb(opened.line_bytes)} kB / {opened.result_bytes} B result |")
        print(f"| grid | {state0['grid']['shape']} voxels, {state0['maxTimeIndex'] + 1} time points |")
        print(f"| viewports | {', '.join(v[0] for v in report['sections']['boot']['viewports'])} |")

        # first-ever renders (torch / LUT warm-up lands on whichever renders first)
        cold_first = {}
        for view in ("V1", "V2", "V3"):
            rec = sc.call("render", {"view": view})
            cold_first[view] = {"ms": rec.dt_ms, "lineBytes": rec.line_bytes,
                                "pngB64": len(rec.result["png"] or "")}
        print(f"| first render each view | V1 {cold_first['V1']['ms']:.1f} ms, "
              f"V2 {cold_first['V2']['ms']:.1f} ms, V3 {cold_first['V3']['ms']:.1f} ms |")
        report["sections"]["boot"]["firstRenderMs"] = {k: v["ms"] for k, v in cold_first.items()}

        first_surface = sc.call("surface", {"view": "S1"})
        report["sections"]["boot"]["firstSurfaceMs"] = first_surface.dt_ms

        # ------------------------------------------------------------- state poll
        print("\n## 1. `state` — the polling snapshot")
        print("\n| condition | n | p50 / p95 / max ms | line bytes (median) |")
        print("|---|---|---|---|")
        poll = [sc.call("state") for _ in range(N)]
        stats = summarize([r.seconds for r in poll])
        line_bytes = int(statistics.median(r.line_bytes for r in poll))
        result_bytes = int(statistics.median(r.result_bytes for r in poll))
        row("state()", stats, f"{line_bytes} B line / {kb(result_bytes)} kB JSON")
        polls_350 = 60000.0 / 350.0
        polls_1000 = 60000.0 / 1000.0
        report["sections"]["state"] = {
            "latencyMs": stats, "lineBytes": line_bytes, "resultBytes": result_bytes,
            "bytesPerMinuteAt350ms": line_bytes * polls_350,
            "bytesPerMinuteAt1000ms": line_bytes * polls_1000,
            "pollsPerMinuteAt350ms": polls_350,
        }
        print(f"\nSnapshot poll bandwidth: **{kb(line_bytes * polls_350)} kB/min** at 350 ms "
              f"({polls_350:.1f} polls/min), {kb(line_bytes * polls_1000)} kB/min at 1000 ms.")

        # ------------------------------------------------------------- commands
        print("\n## 2. Interaction commands (`execute`, `pick`, `pan`, `zoom`)")
        print("\n| command | n | p50 / p95 / max ms | line bytes (median) |")
        print("|---|---|---|---|")
        cmds = {}
        crosshairs = [(20 + (k * 7) % 24, 20 + (k * 11) % 24, 12 + (k * 5) % 24) for k in range(N)]
        recs = []
        for k in range(N):
            ijk = crosshairs[k]
            recs.append(sc.execute(f"SET_IJK {ijk[0]} {ijk[1]} {ijk[2]}"))
        st = summarize([r.seconds for r in recs])
        lb = int(statistics.median(r.line_bytes for r in recs))
        row("execute SET_IJK", st, f"{lb} B")
        cmds["executeSetIjk"] = {"latencyMs": st, "lineBytes": lb}

        recs = [sc.call("pick", {"view": "V1", "row": 32, "col": 32, "action": "crosshair"})
                for _ in range(N)]
        st = summarize([r.seconds for r in recs])
        lb = int(statistics.median(r.line_bytes for r in recs))
        row("pick (click → crosshair)", st, f"{lb} B")
        cmds["pick"] = {"latencyMs": st, "lineBytes": lb,
                        "resultBytes": int(statistics.median(r.result_bytes for r in recs))}

        recs = [sc.call("pan", {"view": "V1", "dx": 0.01, "dy": 0.0}) for _ in range(N)]
        st = summarize([r.seconds for r in recs])
        lb = int(statistics.median(r.line_bytes for r in recs))
        row("pan (one pointermove)", st, f"{lb} B")
        cmds["pan"] = {"latencyMs": st, "lineBytes": lb}
        sc.execute("SET_PAN V1 0 0")

        recs = [sc.call("zoom", {"view": "V1", "factor": 1.1}) for _ in range(N)]
        st = summarize([r.seconds for r in recs])
        lb = int(statistics.median(r.line_bytes for r in recs))
        row("zoom (one right-drag step)", st, f"{lb} B")
        cmds["zoom"] = {"latencyMs": st, "lineBytes": lb}
        sc.execute("SET_ZOOM V1 1")

        recs = [sc.call("step", {"view": "V1", "delta": 1}) for _ in range(N)]
        st = summarize([r.seconds for r in recs])
        lb = int(statistics.median(r.line_bytes for r in recs))
        row("step (one wheel notch, slices)", st, f"{lb} B")
        cmds["step"] = {"latencyMs": st, "lineBytes": lb}
        report["sections"]["commands"] = cmds

        # ------------------------------------------------------------- render cold
        print("\n## 3. `render` — slice PNGs, cold (state changed before every call)")
        print("\n| view | n | p50 / p95 / max ms | PNG b64 (med) | PNG bytes | outlines bytes | line bytes (med) |")
        print("|---|---|---|---|---|---|---|")
        render_cold = {}
        cold_samples: dict[str, list[Record]] = {}
        for view in ("V1", "V2", "V3"):
            recs = []
            for k in range(N):
                ijk = crosshairs[k]
                sc.execute(f"SET_IJK {ijk[0]} {ijk[1]} {ijk[2]}")
                recs.append(sc.call("render", {"view": view}))
            cold_samples[view] = recs
            st = summarize([r.seconds for r in recs])
            png_b64 = int(statistics.median(len(r.result["png"] or "") for r in recs))
            png_bytes = int(statistics.median(b64_binary_len(r.result["png"]) for r in recs))
            outline_bytes = int(statistics.median(
                sum(b64_binary_len(o["segments"]) for o in r.result["outlines"]) for r in recs))
            lb = int(statistics.median(r.line_bytes for r in recs))
            res = recs[len(recs) // 2].result
            row(view, st, f"{kb(png_b64)} kB | {kb(png_bytes)} kB | {kb(outline_bytes)} kB | {kb(lb)} kB")
            render_cold[view] = {
                "latencyMs": st, "pngB64Bytes": png_b64, "pngBinaryBytes": png_bytes,
                "outlineBinaryBytes": outline_bytes, "lineBytes": lb,
                "width": res["width"], "height": res["height"],
                "span": res["viewInfo"]["span"], "extent": res["viewInfo"]["extent"],
                "outlineCount": len(res["outlines"]),
                "outlineSegments": sum(o["count"] for o in res["outlines"]),
            }
        report["sections"]["renderCold"] = render_cold

        # ------------------------------------------------------------- render warm
        print("\n## 4. `render` — warm (identical repeat, in-process cache hit)")
        print("\n| view | n | p50 / p95 / max ms | warm/cold p50 |")
        print("|---|---|---|---|")
        render_warm = {}
        for view in ("V1", "V2", "V3"):
            recs = [sc.call("render", {"view": view}) for _ in range(N)]
            st = summarize([r.seconds for r in recs])
            ratio = st["p50"] / render_cold[view]["latencyMs"]["p50"]
            row(view, st, f"{ratio:.3f}×")
            render_warm[view] = {"latencyMs": st, "ratioP50": ratio}
        report["sections"]["renderWarm"] = render_warm

        # ------------------------------------------------------------- outlines on/off
        print("\n## 5. Render cost of surface outlines (V1 axial)")
        print("\n| surfaces shown | n | p50 / p95 / max ms | line bytes (med) | result bytes (med) |")
        print("|---|---|---|---|---|")
        shown_stats = {"latencyMs": summarize([r.seconds for r in cold_samples["V1"]]),
                       "lineBytes": int(statistics.median(r.line_bytes for r in cold_samples["V1"]))}
        sc.execute("SHOW_SURFACES ''")
        recs = []
        for k in range(N):
            ijk = crosshairs[k]
            sc.execute(f"SET_IJK {ijk[0]} {ijk[1]} {ijk[2]}")
            recs.append(sc.call("render", {"view": "V1"}))
        hidden = {"latencyMs": summarize([r.seconds for r in recs]),
                  "lineBytes": int(statistics.median(r.line_bytes for r in recs)),
                  "resultBytes": int(statistics.median(r.result_bytes for r in recs))}
        sc.execute("SHOW_SURFACES white,pial")
        shown = {"latencyMs": shown_stats["latencyMs"], "lineBytes": shown_stats["lineBytes"],
                 "resultBytes": int(statistics.median(r.result_bytes for r in cold_samples["V1"]))}
        row("white,pial (4 outlines)", shown["latencyMs"],
            f"{shown['lineBytes']} B line / {shown['resultBytes']} B JSON")
        row("none", hidden["latencyMs"],
            f"{hidden['lineBytes']} B line / {hidden['resultBytes']} B JSON")
        report["sections"]["outlines"] = {"shown": shown, "hidden": hidden}

        # ------------------------------------------------------------- canonical renders
        # A fixed slice (crosshair 32,32,24) with the demo's default display, so the
        # per-frame payload table has a stable image to compare alternatives against.
        sc.execute("SET_IJK 32 32 24")
        sc.execute("SET_THRESHOLD S 2.5")
        sc.execute("SET_ZOOM V1 1")
        sc.execute("SET_ZOOM V2 1")
        sc.execute("SET_ZOOM V3 1")
        print("\n## 3b. `render` — canonical cold frame (crosshair 32,32,24, zoom 1)")
        print("\n| view | n | p50 / p95 / max ms | span | PNG b64 | PNG bytes | outlines bytes | line bytes (med) |")
        print("|---|---|---|---|---|---|---|---|")
        canonical = {}
        canonical_records = {}
        for view in ("V1", "V2", "V3"):
            recs = []
            for _ in range(N):
                sc.execute(f"SET_VIEW_LOCKED {view} 1")  # no-op rev bump: cache cleared
                recs.append(sc.call("render", {"view": view}))
            res = recs[0].result
            st = summarize([r.seconds for r in recs])
            png_b64 = int(statistics.median(len(r.result["png"] or "") for r in recs))
            png_bytes = int(statistics.median(b64_binary_len(r.result["png"]) for r in recs))
            outline_bytes = int(statistics.median(
                sum(b64_binary_len(o["segments"]) for o in r.result["outlines"]) for r in recs))
            lb = int(statistics.median(r.line_bytes for r in recs))
            row(view, st, f"{res['viewInfo']['span']} | {kb(png_b64)} kB | {kb(png_bytes)} kB | "
                          f"{kb(outline_bytes)} kB | {kb(lb)} kB")
            canonical[view] = {
                "latencyMs": st, "span": res["viewInfo"]["span"],
                "pngB64Bytes": png_b64, "pngBinaryBytes": png_bytes,
                "outlineBinaryBytes": outline_bytes, "lineBytes": lb,
                "resultBytes": int(statistics.median(r.result_bytes for r in recs)),
                "outlines": len(res["outlines"]),
                "outlineSegments": sum(o["count"] for o in res["outlines"]),
                "record": res,
            }
            canonical_records[view] = recs
        report["sections"]["renderCanonical"] = {k: {kk: vv for kk, vv in v.items() if kk != "record"}
                                                 for k, v in canonical.items()}

        # ------------------------------------------------------------- zoom sweep
        print("\n## 6. `render` — zoom sweep (crop, not interpolate)")
        print("\n| view/zoom | n | p50 / p95 / max ms | span | PNG b64 (med) | line bytes (med) |")
        print("|---|---|---|---|---|---|")
        zooms = {}
        for view in ("V1", "V2", "V3"):
            zooms[view] = {}
            for z in (1, 2, 4, 8):
                sc.execute(f"SET_ZOOM {view} {z}")
                recs = []
                for _ in range(N):
                    sc.execute(f"SET_VIEW_LOCKED {view} 1")  # no-op rev bump: cold render
                    recs.append(sc.call("render", {"view": view}))
                st = summarize([r.seconds for r in recs])
                res = recs[0].result
                png_b64 = int(statistics.median(len(r.result["png"] or "") for r in recs))
                lb = int(statistics.median(r.line_bytes for r in recs))
                row(f"{view} zoom {z}", st, f"{res['viewInfo']['span']} | {kb(png_b64)} kB | {kb(lb)} kB")
                zooms[view][z] = {"latencyMs": st, "span": res["viewInfo"]["span"],
                                  "pngB64Bytes": png_b64, "lineBytes": lb,
                                  "width": res["width"], "height": res["height"]}
            sc.execute(f"SET_ZOOM {view} 1")
        report["sections"]["zoom"] = zooms

        # ------------------------------------------------------------- threshold sweep
        print("\n## 7. `render` — threshold sweep (V1, layer S)")
        print("\n| threshold | n | p50 / p95 / max ms | PNG b64 (med) | line bytes (med) |")
        print("|---|---|---|---|---|")
        thresholds = {}
        for k in range(N):
            value = 1.0 + 4.0 * k / max(1, N - 1)
            sc.execute(f"SET_THRESHOLD S {value:.3f}")
            rec = sc.call("render", {"view": "V1"})
            thresholds[round(value, 3)] = rec
        st = summarize([r.seconds for r in thresholds.values()])
        png_b64 = int(statistics.median(len(r.result["png"] or "") for r in thresholds.values()))
        lb = int(statistics.median(r.line_bytes for r in thresholds.values()))
        row("1.0 → 5.0", st, f"{kb(png_b64)} kB | {kb(lb)} kB")
        sc.execute("SET_THRESHOLD S 2.5")
        report["sections"]["threshold"] = {
            "latencyMs": st, "pngB64Bytes": png_b64, "lineBytes": lb,
            "perThreshold": {str(t): {"ms": r.dt_ms, "pngB64": len(r.result["png"] or "")}
                             for t, r in thresholds.items()},
        }

        # ------------------------------------------------------------- parked redundancy
        print("\n## 8. Parked (unlocked) pane re-render on crosshair moves")
        sc.execute("SET_VIEW_LOCKED V1 0")
        sc.execute("SET_VIEW_POSITION V1 24")
        base = sc.call("render", {"view": "V1"}).result
        same_png = 0
        moved_px = 0
        samples = []
        for k in range(N):
            ijk = crosshairs[k]
            sc.execute(f"SET_IJK {ijk[0]} {ijk[1]} {ijk[2]}")
            rec = sc.call("render", {"view": "V1"})
            res = rec.result
            samples.append(rec)
            if res["png"] == base["png"]:
                same_png += 1
            if res["crosshairPx"] != base["crosshairPx"]:
                moved_px += 1
        sc.execute("SET_VIEW_LOCKED V1 1")
        st = summarize([r.seconds for r in samples])
        lb = int(statistics.median(r.line_bytes for r in samples))
        print(f"\nAcross {N} crosshair moves with V1 parked at slice 24: the PNG was byte-identical "
              f"**{same_png}/{N}** times while `crosshairPx` changed **{moved_px}/{N}** times; "
              f"median response {lb} B at {st['p50'] * 1000:.2f} ms p50. "
              "The whole image is re-sent to move a crosshair line.")
        report["sections"]["parked"] = {
            "n": N, "identicalPng": same_png, "movedCrosshairPx": moved_px,
            "latencyMs": st, "lineBytes": lb,
            "pngB64Bytes": len(base["png"] or ""),
        }

        # ------------------------------------------------------------- surface
        print("\n## 9. `surface` — world-space mesh vs colours only")
        print("\n| case | n | p50 / p95 / max ms | line bytes (med) | mesh b64 bytes | colors b64 bytes |")
        print("|---|---|---|---|---|---|")
        surfaces = {}
        for depth_samples in (1, 5, 9):
            sc.execute(f"SET_SURFACE_DEPTH S1 0.5 0.5 {depth_samples}")
            full = [sc.call("surface", {"view": "S1"}) for _ in range(N)]
            meshrev = full[0].result.get("meshRev")
            fst = summarize([r.seconds for r in full])
            flb = int(statistics.median(r.line_bytes for r in full))
            mesh_b64 = int(statistics.median(
                sum(len(h["positions"]) + len(h["faces"]) for h in r.result["mesh"]["hemis"])
                for r in full))
            colors_b64 = int(statistics.median(
                sum(len(c["rgba"]) for c in r.result["colors"]) for r in full))
            row(f"samples={depth_samples} full mesh", fst, f"{kb(flb)} kB | {kb(mesh_b64)} kB | {kb(colors_b64)} kB")
            colors = [sc.call("surface", {"view": "S1", "meshRev": meshrev}) for _ in range(N)]
            cst = summarize([r.seconds for r in colors])
            clb = int(statistics.median(r.line_bytes for r in colors))
            no_mesh = all("mesh" not in r.result for r in colors)
            row(f"samples={depth_samples} colors only", cst, f"{kb(clb)} kB | none sent={no_mesh} | {kb(colors_b64)} kB")
            res = full[0].result
            surfaces[str(depth_samples)] = {
                "meshRev": meshrev,
                "fullLatencyMs": fst, "fullLineBytes": flb, "meshB64Bytes": mesh_b64,
                "colorsB64Bytes": colors_b64,
                "fullResultBytes": int(statistics.median(r.result_bytes for r in full)),
                "colorsLatencyMs": cst, "colorsLineBytes": clb,
                "colorsResultBytes": int(statistics.median(r.result_bytes for r in colors)),
                "vertices": {h["hemi"]: b64_binary_len(h["positions"]) // 12 for h in res["mesh"]["hemis"]},
                "faces": {h["hemi"]: b64_binary_len(h["faces"]) // 12 for h in res["mesh"]["hemis"]},
                "picking": res.get("picking"), "layer": res.get("layer"),
            }
        sc.execute("SET_SURFACE_DEPTH S1 0.5 0.5 1")
        surfaces_block = {
            "firstCallAfterOpenMs": report["sections"]["boot"]["firstSurfaceMs"],
            "bySamples": surfaces,
            "meshRevStableAcrossDepthSamples": len({surfaces[k]["meshRev"] for k in surfaces}) == 1,
        }
        report["sections"]["surface"] = surfaces_block
        print(f"\nFirst surface call after open (cold): "
              f"{surfaces_block['firstCallAfterOpenMs']:.1f} ms. "
              f"meshRev identical across depth samples: {surfaces_block['meshRevStableAcrossDepthSamples']} "
              "(geometry is keyed on shape/split/hinge/hemis, not sampling).")
        # component breakdown at samples=1
        full_res = sc.call("surface", {"view": "S1"}).result
        comp = []
        for h in full_res["mesh"]["hemis"]:
            comp.append({
                "hemi": h["hemi"],
                "positionsB64": len(h["positions"]),
                "positionsBytes": b64_binary_len(h["positions"]),
                "facesB64": len(h["faces"]),
                "facesBytes": b64_binary_len(h["faces"]),
                "vertices": b64_binary_len(h["positions"]) // 12,
                "triangles": b64_binary_len(h["faces"]) // 12,
            })
        comp_colors = [{"hemi": c["hemi"], "rgbaB64": len(c["rgba"]),
                        "rgbaBytes": b64_binary_len(c["rgba"])} for c in full_res["colors"]]
        report["sections"]["surface"]["components"] = {"mesh": comp, "colors": comp_colors}

        # ------------------------------------------------------------- surface pick
        print("\n## 10. `surface_pick` — server-authoritative vertex picking")
        bounds = full_res["mesh"]["bounds"]
        centre = [(bounds["min"][i] + bounds["max"][i]) / 2.0 for i in range(3)]
        radius = max(1e-6, math.dist(bounds["max"], bounds["min"]) / 2.0)
        distance = radius / math.sin(math.radians(15.0)) * 1.05
        camera = {"rotation": [1, 0, 0, 0, 1, 0, 0, 0, 1], "distance": distance,
                  "target": centre, "fovDeg": 30.0}
        hit_ndc = None
        miss_ndc = (-0.98, -0.98)
        for ndc in [(0.2, 0.0), (-0.2, 0.0), (0.0, 0.2), (0.0, -0.2), (0.35, 0.1),
                    (0.1, 0.3), (-0.35, -0.1), (0.0, 0.0)]:
            probe = sc.call("surface_pick", {"view": "S1", "xNdc": ndc[0], "yNdc": ndc[1],
                                             "aspect": 1.5, "camera": camera}, allow_error=True)
            if probe.ok and hit_ndc is None:
                hit_ndc = ndc
        pick_ok = []
        if hit_ndc is not None:
            for _ in range(N):
                pick_ok.append(sc.call("surface_pick", {"view": "S1", "xNdc": hit_ndc[0],
                                                        "yNdc": hit_ndc[1], "aspect": 1.5,
                                                        "camera": camera}))
        misses = [sc.call("surface_pick", {"view": "S1", "xNdc": miss_ndc[0], "yNdc": miss_ndc[1],
                                           "aspect": 1.5, "camera": camera}, allow_error=True)
                  for _ in range(min(N, 6))]
        pick_stats = summarize([r.seconds for r in pick_ok]) if pick_ok else {"n": 0}
        miss_stats = summarize([r.seconds for r in misses])
        hit_vertex = pick_ok[0].result["vertex"] if pick_ok else None
        print(f"\n| case | n | p50 / p95 / max ms | line bytes (med) |")
        print("|---|---|---|---|")
        if pick_ok:
            row(f"hit at ndc {hit_ndc}", pick_stats, f"{int(statistics.median(r.line_bytes for r in pick_ok))} B")
        row(f"miss (background) {miss_ndc}", miss_stats, f"{int(statistics.median(r.line_bytes for r in misses))} B")
        print(f"\nPicks are resolved to vertex {hit_vertex} in the sidecar; each hit also runs "
              "SET_XYZ + SELECT_SURFACE_VERTEX (two rev bumps) and returns the full snapshot.")
        report["sections"]["surfacePick"] = {
            "camera": camera, "hitNdc": hit_ndc, "missNdc": miss_ndc,
            "hitLatencyMs": pick_stats, "missLatencyMs": miss_stats,
            "hitLineBytes": int(statistics.median(r.line_bytes for r in pick_ok)) if pick_ok else None,
            "missLineBytes": int(statistics.median(r.line_bytes for r in misses)),
            "hitResultBytes": int(statistics.median(r.result_bytes for r in pick_ok)) if pick_ok else None,
        }

        # ------------------------------------------------------------- series
        print("\n## 11. `series` — graph window data (80 time points)")
        print("\n| grid | cells | n | p50 / p95 / max ms | line bytes (med) | result bytes (med) |")
        print("|---|---|---|---|---|---|")
        series = {}
        for grid in (1, 2, 4, 8, 16):
            sc.execute(f"SET_VIEW_GRID G1 {grid}")
            n_series = N if grid <= 4 else max(10, N // 3)
            recs = [sc.call("series", {"view": "G1"}) for _ in range(n_series)]
            st = summarize([r.seconds for r in recs])
            lb = int(statistics.median(r.line_bytes for r in recs))
            rb = int(statistics.median(r.result_bytes for r in recs))
            cells = len(recs[0].result.get("cells", []))
            traces = sum(len(c["traces"]) for c in recs[0].result.get("cells", []))
            points = sum(len(t["values"]) for c in recs[0].result.get("cells", [])
                         for t in c["traces"])
            row(f"grid {grid}×{grid}", st,
                f"{cells} cells ({traces} traces, {points} pts) — {kb(lb)} kB line / {kb(rb)} kB JSON")
            series[str(grid)] = {"cells": cells, "traces": traces, "points": points,
                                 "latencyMs": st, "lineBytes": lb, "resultBytes": rb,
                                 "entries": len(recs[0].result.get("entries", []))}
        sc.execute("SET_VIEW_GRID G1 2")
        report["sections"]["series"] = series

        # ------------------------------------------------------------- node proxy
        proxy = {"available": False, "reason": "skipped"}
        render_rec = canonical["V1"]["record"]
        # Fetched regardless of --skip-node: the alternatives section below uses
        # them, and the colors-only call exercises the incremental token path.
        full_json = sc.call("surface", {"view": "S1"}).result
        state_rec = sc.call("state").result
        if not args.skip_node:
            print("\n## 12. Client CPU proxy (Node/V8; NOT browser frame timing)")
            print("\n| operation | n | p50 / p95 / max ms |")
            print("|---|---|---|---|")
            colors_only = sc.call(
                "surface", {"view": "S1", "meshRev": full_json["meshRev"]}
            ).result
            series4 = None
            sc.execute("SET_VIEW_GRID G1 4")
            series4 = sc.call("series", {"view": "G1"}).result
            sc.execute("SET_VIEW_GRID G1 2")
            lh = full_json["mesh"]["hemis"][0]
            payload = {
                "state_json": json.dumps(state_rec, separators=(",", ":")),
                "render_json": json.dumps(render_rec, separators=(",", ":")),
                "surface_colors_json": json.dumps(colors_only, separators=(",", ":")),
                "surface_full_json": json.dumps(full_json, separators=(",", ":")),
                "series_json": json.dumps(series4, separators=(",", ":")),
                "png_b64": render_rec["png"],
                "outline_b64": render_rec["outlines"][0]["segments"] if render_rec["outlines"] else "",
                "colors_b64": full_json["colors"][0]["rgba"],
                "positions_b64": lh["positions"],
                "faces_b64": lh["faces"],
            }
            proxy = node_proxy(payload, stderr_path.parent)
            if proxy.get("available") and proxy.get("error"):
                print(f"\nnode proxy reported: {proxy['error']}")
            if proxy.get("available") and not proxy.get("error"):
                for b in proxy["benches"]:
                    print(f"| {b['name']} | {b['n']} | {b['p50']:.3f} / {b['p95']:.3f} / {b['max']:.3f} |")
                print(f"\nNode {proxy.get('node')}; V8 JIT, same machine. "
                      "The browser adds React reconciliation, canvas drawImage and GPU upload "
                      "(not measurable in this checkout).")
            elif not proxy.get("error"):
                print(f"\nnode proxy unavailable: {proxy.get('reason')}")
        report["sections"]["clientProxy"] = proxy

        # ------------------------------------------------------------- alternative payloads
        print("\n## 13. Alternative payload arithmetic (measured on the same demo data)")
        print("\n| representation | bytes | b64 bytes on the JSON wire |")
        print("|---|---|---|")
        alternatives = {}
        try:
            import nibabel as nib

            anat = nib.load(str(ROOT / "data" / "demo" / "anat.nii.gz"))
            stats_img = nib.load(str(ROOT / "data" / "demo" / "stats.nii.gz"))
            anat_data = np.asanyarray(anat.dataobj, dtype=np.float32)
            stats_data = np.asanyarray(stats_img.dataobj, dtype=np.float32)
            planes = {
                "V1": anat_data[:, :, 24].astype("<f4"),
                "V2": anat_data[32, :, :].astype("<f4"),
                "V3": anat_data[:, 32, :].astype("<f4"),
            }
            alt_planes = {}
            for view, plane in planes.items():
                raw = plane.tobytes()
                zraw = zlib.compress(raw, 1)
                alt_planes[view] = {
                    "shape": list(plane.shape),
                    "rawF32Bytes": len(raw),
                    "rawF32B64Bytes": 4 * ((len(raw) + 2) // 3),
                    "zlibF32Bytes": len(zraw),
                    "zlibF32B64Bytes": 4 * ((len(zraw) + 2) // 3),
                    "rgba8Bytes": int(np.prod(plane.shape)) * 4,
                    "currentPngBinaryBytes": render_cold[view]["pngBinaryBytes"],
                    "currentPngB64Bytes": render_cold[view]["pngB64Bytes"],
                }
                print(f"| {view} raw float32 plane | {len(raw)} | {4 * ((len(raw) + 2) // 3)} "
                      f"| zlib: {len(zraw)} / {4 * ((len(zraw) + 2) // 3)} |")
            volumes = {
                "anatF32Bytes": int(np.prod(anat_data.shape)) * 4,
                "statsF32Bytes": int(np.prod(stats_data.shape)) * 4,
                "funcF32Bytes": 64 * 64 * 48 * 80 * 4,
            }
            alternatives["planes"] = alt_planes
            alternatives["volumes"] = volumes
            print(f"\nWhole-volume float32: anat {kb(volumes['anatF32Bytes'])} kB, "
                  f"stats {kb(volumes['statsF32Bytes'])} kB, func (80 vols) "
                  f"{kb(volumes['funcF32Bytes'])} kB — the residency cost of a WebGL volume path.")

            # measure PNG re-encode of the current slice at native / 2x / 4x / 8x
            from ffsviewer import png as ffs_png

            rgba = decode_png_rgba(base64.b64decode(render_rec["png"]))
            upsampling = {}
            for factor in (1, 2, 4, 8):
                big = np.repeat(np.repeat(rgba, factor, axis=0), factor, axis=1)
                t0 = time.perf_counter()
                encoded = ffs_png.encode_rgba(big)
                dur = time.perf_counter() - t0
                upsampling[str(factor)] = {
                    "width": int(big.shape[1]), "height": int(big.shape[0]),
                    "pngBytes": len(encoded),
                    "pngB64Bytes": 4 * ((len(encoded) + 2) // 3),
                    "encodeMs": dur * 1000.0,
                    "vsNativePngBytes": len(encoded) / max(1, len(base64.b64decode(render_rec["png"]))),
                }
            alternatives["upsampleSimulation"] = upsampling
            print("\n| server output size | pixels | PNG bytes (nearest upscale) | × native | encode ms |")
            print("|---|---|---|---|---|")
            for factor, info in upsampling.items():
                print(f"| {factor}× ({info['width']}×{info['height']}) | "
                      f"{info['width'] * info['height']} | {info['pngBytes']} | "
                      f"{info['vsNativePngBytes']:.2f}× | {info['encodeMs']:.2f} |")
            print("\n(Nearest-neighbour re-encode of the real V1 output through the sidecar's own "
                  "PNG encoder: a wire-cost simulation of rendering at display resolution, not an "
                  "implemented path. Interpolated output would compress worse.)")

            # compression ratios of the big binary payloads
            def ratios(full_result):
                pos = b"".join(base64.b64decode(h["positions"]) for h in full_result["mesh"]["hemis"])
                faces = b"".join(base64.b64decode(h["faces"]) for h in full_result["mesh"]["hemis"])
                cols = b"".join(base64.b64decode(c["rgba"]) for c in full_result["colors"])
                outs = b"".join(base64.b64decode(o["segments"]) for o in render_rec["outlines"])
                return {
                    "meshPositions": {"bytes": len(pos), "zlibRatio": zratio(pos)},
                    "meshFaces": {"bytes": len(faces), "zlibRatio": zratio(faces)},
                    "surfaceColors": {"bytes": len(cols), "zlibRatio": zratio(cols)},
                    "sliceOutlines": {"bytes": len(outs), "zlibRatio": zratio(outs)},
                    "stateJson": {"bytes": len(json.dumps(state_rec, separators=(",", ":"))),
                                  "zlibRatio": zratio(json.dumps(state_rec, separators=(",", ":")).encode())},
                    "renderJson": {"bytes": len(json.dumps(render_rec, separators=(",", ":"))),
                                   "zlibRatio": zratio(json.dumps(render_rec, separators=(",", ":")).encode())},
                }
            alternatives["compressibility"] = ratios(full_json)
            alternatives["funcTimePoints"] = int(state0["maxTimeIndex"]) + 1
        except Exception as exc:  # pragma: no cover - diagnostics only
            import traceback
            traceback.print_exc()
            alternatives["error"] = str(exc)
        report["sections"]["alternatives"] = alternatives

        # ------------------------------------------------------------- derived client budget
        print("\n## 14. Derived client budget (default demo layout)")
        print("\n| estimate | value | basis |")
        print("|---|---|---|")
        poll_bytes = report["sections"]["state"]["lineBytes"]
        render_line = render_cold["V1"]["lineBytes"]
        surface_colors_line = surfaces["1"]["colorsLineBytes"]
        series2_line = series["2"]["lineBytes"]
        pick_line = cmds["pick"]["lineBytes"]
        per_click = poll_bytes + pick_line + render_line + surface_colors_line + series2_line
        poll_interval = 0.350
        pan_response = cmds["pan"]["lineBytes"]
        burst = {
            "clickInboundBytes": per_click,
            "clickComponents": {"poll": poll_bytes, "pick": pick_line, "renderV1": render_line,
                                "surfaceColors": surface_colors_line, "seriesGrid2": series2_line},
            "panCommandsPerSecondAssumed": 60,
            "panResponseBytesPerSecond": pan_response * 60,
            "pollDrivenBytesPerSecond": per_click * (1.0 / poll_interval),
            "panDragTotalBytesPerSecond": pan_response * 60 + per_click / poll_interval,
        }
        print(f"| one click, all panes refetch | {kb(per_click)} kB | "
              f"poll {kb(poll_bytes)} + pick {kb(pick_line)} + render {kb(render_line)} "
              f"+ surface colours {kb(surface_colors_line)} + series {kb(series2_line)} |")
        print(f"| drag: 60 commands/s assumed + 350 ms poll | {kb(burst['panDragTotalBytesPerSecond'])} kB/s | "
              f"{pan_response} B × 60 + {kb(per_click / poll_interval)} kB/s |")
        latency = {
            "sidecarPickMs": cmds["pick"]["latencyMs"]["p50"] * 1000.0,
            "sidecarRenderMs": canonical["V1"]["latencyMs"]["p50"] * 1000.0,
            "clientPngDecodeMs": None,
            "pollWaitMeanMs": 175.0,
            "pollWaitMaxMs": 350.0,
        }
        if proxy.get("available"):
            bench_by_name = {b["name"]: b for b in proxy["benches"]}
            dec = bench_by_name.get("decode:png_inflate_unfilter")
            if dec:
                latency["clientPngDecodeMs"] = dec["p50"]
        measured = latency["sidecarPickMs"] + latency["sidecarRenderMs"] + (latency["clientPngDecodeMs"] or 0.0)
        latency["measuredSidecarPlusDecodeMs"] = measured
        latency["architecturalPollShare"] = latency["pollWaitMeanMs"] / (measured + latency["pollWaitMeanMs"])
        print(f"| click → new pixels | {measured + latency['pollWaitMeanMs']:.0f} ms mean | "
              f"pick {latency['sidecarPickMs']:.2f} + render {latency['sidecarRenderMs']:.2f} + "
              f"PNG decode {latency['clientPngDecodeMs'] or 0:.2f} + poll wait ~175 ms |")
        print(f"| poll wait share of click latency | {latency['architecturalPollShare'] * 100:.1f}% | "
              "client polls on a 350 ms timer, not on command completion |")
        report["sections"]["clientBudget"] = {"burst": burst, "latency": latency,
                                              "panelAssumption": PANEL}

        print("\n=== JSON ===")
        print(json.dumps(report, indent=2, default=str))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
