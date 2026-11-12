"""Drive the Harness FFS viewer sidecar as a subprocess (NDJSON on stdio).

This module knows nothing about what the viewer *should* compute: it only
speaks the transport documented in ``docs/API.md`` and decodes the payloads
(PNG included, with ``zlib``/``struct`` only, no Pillow).

The sidecar is spawned exactly as the Host plugin spawns it::

    .venv/bin/python -u -m ffsviewer.server \
        --project-root <repo> --state-dir <tmp> --no-autosave

with ``PYTHONPATH=<repo>/python:<repo>/reference/fastfuncstuff``.
"""

from __future__ import annotations

import base64
import json
import os
import queue
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PYTHON = str(ROOT / ".venv" / "bin" / "python")
PYTHONPATH = os.pathsep.join([str(ROOT / "python"), str(ROOT / "reference" / "fastfuncstuff")])


class SidecarError(RuntimeError):
    """A sidecar request came back ``{ok: false}``."""

    def __init__(self, method: str, error: dict) -> None:
        self.code = str(error.get("code", ""))
        self.details = error.get("details") or {}
        self.message = str(error.get("message", ""))
        super().__init__(f"{method}: [{self.code}] {self.message}")


class SidecarTransportError(RuntimeError):
    """The sidecar process died or stopped answering."""


class Sidecar:
    """One sidecar process with a temporary state directory."""

    def __init__(
        self,
        state_dir: str | Path | None = None,
        *,
        project_root: str | Path = ROOT,
        autosave: bool = False,
        name: str = "sidecar",
    ) -> None:
        self._auto_state_dir = state_dir is None
        if state_dir is None:
            state_dir = tempfile.mkdtemp(prefix=f"ffs-verify-{name}-")
        self.state_dir = Path(state_dir)
        self.project_root = Path(project_root)
        self.autosave = autosave
        self.name = name
        self.proc: subprocess.Popen | None = None
        self._lines: queue.Queue = queue.Queue()
        self._stderr: list[str] = []
        self._next_id = 0
        self._lock = threading.Lock()

    # -- lifecycle -----------------------------------------------------
    def start(self) -> "Sidecar":
        if self.proc is not None:
            return self
        self.state_dir.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ)
        env["PYTHONPATH"] = PYTHONPATH
        # Keep imports single-threaded-ish and deterministic.
        env.setdefault("OMP_NUM_THREADS", "1")
        args = [
            PYTHON,
            "-u",
            "-m",
            "ffsviewer.server",
            "--project-root",
            str(self.project_root),
            "--state-dir",
            str(self.state_dir),
        ]
        if not self.autosave:
            args.append("--no-autosave")
        self.proc = subprocess.Popen(
            args,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
            env=env,
            cwd=str(self.project_root),
        )
        assert self.proc.stdout is not None and self.proc.stderr is not None
        threading.Thread(target=self._pump_stdout, args=(self.proc.stdout,), daemon=True).start()
        threading.Thread(target=self._pump_stderr, args=(self.proc.stderr,), daemon=True).start()
        self._await_ready()
        return self

    def _pump_stdout(self, stream) -> None:
        try:
            for line in stream:
                self._lines.put(line)
        except Exception:  # noqa: BLE001 - process closing
            pass
        finally:
            self._lines.put(None)

    def _pump_stderr(self, stream) -> None:
        try:
            for line in stream:
                self._stderr.append(line.rstrip("\n"))
                if len(self._stderr) > 400:
                    del self._stderr[:200]
        except Exception:  # noqa: BLE001
            pass

    def _await_ready(self, timeout: float = 60.0) -> None:
        # The sidecar prints a banner on stderr before reading stdin; there is
        # no hello handshake required, so probe with the cheapest method.
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                result = self.call("hello", timeout=2.0)
                if isinstance(result, dict) and "version" in result:
                    self.hello = result
                    return
            except (SidecarTransportError, SidecarError):
                time.sleep(0.02)
        raise SidecarTransportError(
            "sidecar did not become ready; stderr tail:\n" + "\n".join(self._stderr[-20:])
        )

    def close(self, timeout: float = 20.0) -> None:
        proc = self.proc
        if proc is None:
            return
        try:
            if proc.poll() is None:
                self.request("shutdown", timeout=timeout)
        except Exception:  # noqa: BLE001 - best effort
            pass
        try:
            proc.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)
        self.proc = None
        if self._auto_state_dir:
            shutil.rmtree(self.state_dir, ignore_errors=True)

    def kill(self) -> None:
        if self.proc is not None and self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait(timeout=5)
        self.proc = None
        if self._auto_state_dir:
            shutil.rmtree(self.state_dir, ignore_errors=True)

    # -- transport -----------------------------------------------------
    def request(self, method: str, params: dict | None = None, timeout: float = 300.0) -> dict:
        with self._lock:
            proc = self.proc
            if proc is None or proc.poll() is not None:
                raise SidecarTransportError(
                    f"sidecar {self.name} is not running; stderr tail:\n"
                    + "\n".join(self._stderr[-20:])
                )
            self._next_id += 1
            request_id = self._next_id
            payload = {"id": request_id, "method": method}
            if params is not None:
                payload["params"] = params
            assert proc.stdin is not None
            proc.stdin.write(json.dumps(payload) + "\n")
            proc.stdin.flush()
            try:
                line = self._lines.get(timeout=timeout)
            except queue.Empty as exc:
                raise SidecarTransportError(
                    f"sidecar {self.name} timed out after {timeout}s on {method!r}"
                ) from exc
            if line is None:
                raise SidecarTransportError(
                    f"sidecar {self.name} closed stdout on {method!r}; stderr tail:\n"
                    + "\n".join(self._stderr[-20:])
                )
            response = json.loads(line)
            if not isinstance(response, dict) or response.get("id") != request_id:
                raise SidecarTransportError(f"unexpected response to {method!r}: {line!r}")
            return response

    def call(self, method: str, timeout: float = 300.0, **params) -> dict:
        """Send one request and return ``result``; raise :class:`SidecarError` on failure."""
        response = self.request(method, params or None, timeout=timeout)
        if not response.get("ok"):
            raise SidecarError(method, response.get("error") or {})
        return response["result"]

    def try_call(self, method: str, **params) -> tuple[bool, dict]:
        """Like :meth:`call` but returns ``(ok, result_or_error)``."""
        response = self.request(method, params or None)
        if response.get("ok"):
            return True, response["result"]
        return False, response.get("error") or {}

    # -- methods -------------------------------------------------------
    def open(self, preset: str = "demo", **params) -> dict:
        return self.call("open", preset=preset, **params)

    def execute(self, line: str, origin: str = "ui") -> dict:
        return self.call("execute", line=line, origin=origin)

    def execute_batch(self, lines: list[str], origin: str = "ui") -> dict:
        return self.call("execute_batch", lines=list(lines), origin=origin)

    def snapshot(self) -> dict:
        return self.call("state")

    def render(self, view: str, outline_token: str | None = None) -> dict:
        params = {"view": view}
        if outline_token is not None:
            params["outlineToken"] = outline_token
        return self.call("render", **params)

    def pick(self, view: str, row: int, col: int, action: str = "crosshair") -> dict:
        return self.call("pick", view=view, row=int(row), col=int(col), action=action)

    def surface(
        self,
        view: str,
        mesh_rev: str | None = None,
        colors_token: str | None = None,
    ) -> dict:
        params = {"view": view}
        if mesh_rev is not None:
            params["meshRev"] = mesh_rev
        if colors_token is not None:
            params["colorsToken"] = colors_token
        return self.call("surface", **params)

    def surface_pick(
        self,
        view: str,
        camera: dict,
        x_ndc: float,
        y_ndc: float,
        aspect: float,
    ) -> dict:
        return self.call(
            "surface_pick",
            view=view,
            xNdc=float(x_ndc),
            yNdc=float(y_ndc),
            aspect=float(aspect),
            camera=camera,
        )

    def save(self, note: str | None = None) -> dict:
        return self.call("save", note=note)

    def restore(self) -> dict:
        return self.call("restore")

    def workspace(self, layout: dict | None = None) -> dict:
        return self.call("workspace", **({} if layout is None else {"layout": layout}))

    def shutdown(self) -> dict:
        return self.call("shutdown")


# -- payload decoding --------------------------------------------------


def decode_png(data_b64: str) -> "object":
    """Decode a base64 RGBA8 PNG to ``numpy.uint8 (H, W, 4)``.

    Implemented with ``zlib``/``struct`` only. Handles the five PNG scanline
    filters; the sidecar's encoder emits filter 0, so any other filter showing
    up is itself worth knowing about, but decoding it keeps the check honest.
    """
    import numpy as np

    raw = base64.b64decode(data_b64)
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG (bad signature)")
    pos = 8
    width = height = None
    idat = bytearray()
    while pos + 8 <= len(raw):
        length = struct.unpack(">I", raw[pos : pos + 4])[0]
        tag = raw[pos + 4 : pos + 8]
        body = raw[pos + 8 : pos + 8 + length]
        crc = struct.unpack(">I", raw[pos + 8 + length : pos + 12 + length])[0]
        if zlib.crc32(tag + body) & 0xFFFFFFFF != crc:
            raise ValueError(f"PNG chunk {tag!r} has a bad CRC")
        pos += 12 + length
        if tag == b"IHDR":
            width, height, depth, colour, compression, filt, interlace = struct.unpack(
                ">IIBBBBB", body
            )
            if (depth, colour, compression, filt, interlace) != (8, 6, 0, 0, 0):
                raise ValueError(
                    f"unsupported PNG IHDR: depth={depth} colour={colour} "
                    f"interlace={interlace}"
                )
        elif tag == b"IDAT":
            idat += body
        elif tag == b"IEND":
            break
    if width is None or not idat:
        raise ValueError("PNG has no IHDR or no IDAT")
    planes = zlib.decompress(bytes(idat))
    stride = width * 4
    if len(planes) != height * (stride + 1):
        raise ValueError(
            f"PNG scanline size mismatch: {len(planes)} != {height * (stride + 1)}"
        )
    out = np.empty((height, width, 4), np.uint8)
    prev = np.zeros(stride, np.uint8)
    pos = 0
    for row in range(height):
        filt = planes[pos]
        pos += 1
        line = np.frombuffer(planes[pos : pos + stride], np.uint8).copy()
        pos += stride
        if filt == 0:
            pass
        elif filt == 1:  # Sub
            for i in range(4, stride):
                line[i] = (int(line[i]) + int(line[i - 4])) & 0xFF
        elif filt == 2:  # Up
            line = (line.astype(np.int16) + prev.astype(np.int16)).astype(np.uint8)
        elif filt == 3:  # Average
            for i in range(stride):
                left = int(line[i - 4]) if i >= 4 else 0
                line[i] = (int(line[i]) + ((left + int(prev[i])) >> 1)) & 0xFF
        elif filt == 4:  # Paeth
            for i in range(stride):
                a = int(line[i - 4]) if i >= 4 else 0
                b = int(prev[i])
                c = int(prev[i - 4]) if i >= 4 else 0
                p = a + b - c
                pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                pred = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (int(line[i]) + pred) & 0xFF
        else:
            raise ValueError(f"unknown PNG filter {filt}")
        out[row] = line.reshape(width, 4)
        prev = line
    return out


def b64_u8(data: str) -> "object":
    import numpy as np

    return np.frombuffer(base64.b64decode(data), np.uint8)


def b64_f32(data: str) -> "object":
    import numpy as np

    return np.frombuffer(base64.b64decode(data), "<f4")


def b64_u32(data: str) -> "object":
    import numpy as np

    return np.frombuffer(base64.b64decode(data), "<u4")
