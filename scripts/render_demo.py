"""Render demonstration screenshots through the real FFS viewer pipeline.

Slices, surfaces and series all come from the sidecar's authenticated interface (or the
same FFS functions it calls); nothing here re-implements viewer science. Used to produce
the images in the delivery report and `screenshots/`.

    .venv/bin/python scripts/render_demo.py
"""

from __future__ import annotations

import base64
import json
import os
import struct
import subprocess
import sys
import zlib
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "python"))
sys.path.insert(0, str(ROOT / "reference" / "fastfuncstuff"))

from ffsviewer.png import encode_rgba  # noqa: E402

OUT = ROOT / "screenshots"
BG = np.array([10, 13, 17, 255], np.uint8)


class Sidecar:
    def __init__(self, state_dir: Path) -> None:
        env = dict(os.environ)
        env["PYTHONPATH"] = (
            f"{ROOT / 'python'}{os.pathsep}{ROOT / 'reference' / 'fastfuncstuff'}"
        )
        self.proc = subprocess.Popen(
            [
                str(ROOT / ".venv" / "bin" / "python"), "-u", "-m", "ffsviewer.server",
                "--project-root", str(ROOT), "--state-dir", str(state_dir), "--no-autosave",
            ],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            env=env, text=True, cwd=str(ROOT),
        )
        self.next_id = 1

    def call(self, method: str, params: dict | None = None) -> dict:
        request_id = self.next_id
        self.next_id += 1
        self.proc.stdin.write(json.dumps({"id": request_id, "method": method, "params": params or {}}) + "\n")
        self.proc.stdin.flush()
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError(self.proc.stderr.read()[-4000:])
            response = json.loads(line)
            if response.get("id") == request_id:
                if not response["ok"]:
                    raise RuntimeError(response["error"])
                return response["result"]

    def close(self) -> None:
        try:
            self.call("shutdown")
        finally:
            self.proc.wait(timeout=30)


def decode_png(data: bytes) -> np.ndarray:
    """Decode the filter-0 RGBA PNGs the sidecar writes."""
    pos = 8
    width = height = 0
    idat = b""
    while pos < len(data):
        length = struct.unpack(">I", data[pos : pos + 4])[0]
        tag = data[pos + 4 : pos + 8]
        payload = data[pos + 8 : pos + 8 + length]
        pos += 12 + length
        if tag == b"IHDR":
            width, height = struct.unpack(">II", payload[:8])
        elif tag == b"IDAT":
            idat += payload
        elif tag == b"IEND":
            break
    raw = zlib.decompress(idat)
    out = np.empty((height, width, 4), np.uint8)
    stride = width * 4 + 1
    for y in range(height):
        row = raw[y * stride : (y + 1) * stride]
        assert row[0] == 0, "expected filter 0"
        out[y] = np.frombuffer(row[1:], np.uint8).reshape(width, 4)
    return out


def draw_border(canvas: np.ndarray, x: int, y: int, w: int, h: int, color=(46, 56, 68, 255)) -> None:
    canvas[y : y + h, x : x + 2] = color
    canvas[y : y + h, x + w - 2 : x + w] = color
    canvas[y : y + 2, x : x + w] = color
    canvas[y + h - 2 : y + h, x : x + w] = color


def blit(canvas: np.ndarray, image: np.ndarray, x: int, y: int, scale: float = 1.0) -> tuple[int, int]:
    if scale != 1.0:
        h = max(1, int(round(image.shape[0] * scale)))
        w = max(1, int(round(image.shape[1] * scale)))
        yi = np.minimum((np.arange(h) / scale).astype(int), image.shape[0] - 1)
        xi = np.minimum((np.arange(w) / scale).astype(int), image.shape[1] - 1)
        image = image[yi][:, xi]
    h, w = image.shape[:2]
    canvas[y : y + h, x : x + w, :3] = image[..., :3]
    return w, h


# --------------------------------------------------------------------------- surface


def rasterize_surface(mesh: dict, colors: dict, width: int = 560, height: int = 420) -> np.ndarray:
    """A small z-buffered renderer over FFS world-space meshes and per-vertex RGBA."""
    canvas = np.zeros((height, width, 4), np.float32)
    canvas[..., :3] = BG[:3] / 255.0
    canvas[..., 3] = 1.0
    depth = np.full((height, width), np.inf, np.float32)
    all_positions = []
    decoded = []
    for hemi in mesh["hemis"]:
        pos = np.frombuffer(base64.b64decode(hemi["positions"]), "<f4").reshape(-1, 3)
        faces = np.frombuffer(base64.b64decode(hemi["faces"]), "<u4").reshape(-1, 3)
        rgba = np.frombuffer(base64.b64decode(colors[hemi["hemi"]]), np.uint8).reshape(-1, 4)
        decoded.append((pos, faces, rgba))
        all_positions.append(pos)
    points = np.concatenate(all_positions)
    lo, hi = points.min(0), points.max(0)
    target = 0.5 * (lo + hi)
    radius = 0.5 * float(np.linalg.norm(hi - lo))
    distance = radius / np.sin(np.radians(30) / 2) * 1.05

    # FFS Camera: identity rotation looks down from above, anterior up.
    rotation = np.array([[0.92, 0.0, 0.39], [0.0, 1.0, 0.0], [-0.39, 0.0, 0.92]])
    view = np.eye(4)
    view[:3, :3] = rotation
    view[:3, 3] = -rotation @ target
    view[2, 3] -= distance
    f = 1.0 / np.tan(np.radians(30) / 2)
    near, far = max(distance * 0.05, 1.0), distance * 4 + 500.0
    proj = np.zeros((4, 4))
    proj[0, 0] = f / (width / height)
    proj[1, 1] = f
    proj[2, 2] = (far + near) / (near - far)
    proj[2, 3] = 2 * far * near / (near - far)
    proj[3, 2] = -1.0
    mvp = proj @ view
    light = np.array([0.35, 0.5, 0.85])
    light = light / np.linalg.norm(light)

    for pos, faces, rgba in decoded:
        clip = np.c_[pos, np.ones(len(pos))] @ mvp.T
        w = clip[:, 3]
        w = np.where(np.abs(w) < 1e-9, 1e-9, w)
        ndc = clip[:, :3] / w[:, None]
        sx = (ndc[:, 0] + 1) * 0.5 * (width - 1)
        sy = (1 - ndc[:, 1]) * 0.5 * (height - 1)
        sz = ndc[:, 2]
        for face in faces:
            i0, i1, i2 = int(face[0]), int(face[1]), int(face[2])
            if max(w[i0], w[i1], w[i2]) <= 0:
                continue
            x0, y0, z0 = sx[i0], sy[i0], sz[i0]
            x1, y1, z1 = sx[i1], sy[i1], sz[i1]
            x2, y2, z2 = sx[i2], sy[i2], sz[i2]
            minx = max(0, int(np.floor(min(x0, x1, x2))))
            maxx = min(width - 1, int(np.ceil(max(x0, x1, x2))))
            miny = max(0, int(np.floor(min(y0, y1, y2))))
            maxy = min(height - 1, int(np.ceil(max(y0, y1, y2))))
            if minx > maxx or miny > maxy:
                continue
            area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
            if abs(area) < 1e-9:
                continue
            normal = np.cross(pos[i1] - pos[i0], pos[i2] - pos[i0])
            norm = np.linalg.norm(normal)
            shade = 0.38 + 0.62 * abs(float(normal @ light) / norm) if norm else 0.6
            rgb0 = rgba[i0, :3].astype(np.float32) * shade
            rgb1 = rgba[i1, :3].astype(np.float32) * shade
            rgb2 = rgba[i2, :3].astype(np.float32) * shade
            alpha0 = rgba[i0, 3] / 255.0
            alpha1 = rgba[i1, 3] / 255.0
            alpha2 = rgba[i2, 3] / 255.0
            yy, xx = np.mgrid[miny : maxy + 1, minx : maxx + 1]
            px = xx + 0.5
            py = yy + 0.5
            b0 = ((x1 - px) * (y2 - py) - (x2 - px) * (y1 - py)) / area
            b1 = ((x2 - px) * (y0 - py) - (x0 - px) * (y2 - py)) / area
            b2 = 1.0 - b0 - b1
            inside = (b0 >= -1e-4) & (b1 >= -1e-4) & (b2 >= -1e-4)
            if not inside.any():
                continue
            z = b0 * z0 + b1 * z1 + b2 * z2
            region_depth = depth[miny : maxy + 1, minx : maxx + 1]
            hit = inside & (z < region_depth)
            if not hit.any():
                continue
            region_depth[hit] = z[hit]
            rgb = (
                b0[..., None] * rgb0 + b1[..., None] * rgb1 + b2[..., None] * rgb2
            )
            a = b0 * alpha0 + b1 * alpha1 + b2 * alpha2
            region = canvas[miny : maxy + 1, minx : maxx + 1]
            region[hit, :3] = rgb[hit] / 255.0
            region[hit, 3] = a[hit]
    return np.clip(canvas * 255, 0, 255).astype(np.uint8)


# --------------------------------------------------------------------------- series


def render_series(series: dict, width: int = 900, height: int = 300) -> np.ndarray:
    canvas = np.zeros((height, width, 4), np.float32)
    canvas[..., :3] = BG[:3] / 255.0
    canvas[..., 3] = 1
    cells = series["cells"]
    n = series["gridN"]
    if not cells:
        return np.clip(canvas * 255, 0, 255).astype(np.uint8)
    gap = 10
    cw = (width - gap * (n + 1)) / n
    ch = (height - gap * (n + 1)) / n
    values = [v for cell in cells for trace in cell["traces"] for v in trace["values"]]
    lo, hi = (min(values), max(values)) if values else (-1, 1)
    pad = (hi - lo) * 0.08 or 1
    lo -= pad
    hi += pad
    palette = np.array(
        [[122, 162, 247], [247, 118, 142], [158, 206, 106], [224, 175, 104], [187, 154, 247], [125, 207, 255]],
        np.float32,
    )

    def line(x0, y0, x1, y1, color, alpha=1.0):
        steps = max(2, int(max(abs(x1 - x0), abs(y1 - y0))))
        xs = np.linspace(x0, x1, steps)
        ys = np.linspace(y0, y1, steps)
        for x, y in zip(xs, ys):
            xi, yi = int(round(x)), int(round(y))
            if 0 <= xi < width and 0 <= yi < height:
                canvas[yi, xi, :3] = canvas[yi, xi, :3] * (1 - alpha) + color * alpha
                canvas[yi, xi, 3] = 1

    for row in range(n):
        for col in range(n):
            cell = cells[row * n + col]
            x0 = gap + col * (cw + gap)
            y0 = gap + row * (ch + gap)
            if cell.get("tint"):
                tint = np.array(cell["tint"], np.float32)
                canvas[int(y0) : int(y0 + ch), int(x0) : int(x0 + cw), :3] = (
                    canvas[int(y0) : int(y0 + ch), int(x0) : int(x0 + cw), :3] * 0.82 + tint * 0.18
                )
            edge = np.array([0.35, 0.45, 0.58], np.float32) if cell.get("centre") else np.array([0.12, 0.15, 0.19], np.float32)
            line(x0, y0, x0 + cw, y0, edge)
            line(x0, y0 + ch, x0 + cw, y0 + ch, edge)
            line(x0, y0, x0, y0 + ch, edge)
            line(x0 + cw, y0, x0 + cw, y0 + ch, edge)
            for index, trace in enumerate(cell["traces"]):
                vals = np.asarray(trace["values"], np.float64)
                if not vals.size:
                    continue
                xs = x0 + np.linspace(0, cw, vals.size)
                ys = y0 + ch - (vals - lo) / max(hi - lo, 1e-9) * ch
                color = palette[index % len(palette)] / 255.0
                for i in range(1, len(xs)):
                    line(xs[i - 1], ys[i - 1], xs[i], ys[i], color, 0.9)
            t = series["timeIndex"]
            max_t = max(1, series["maxTimeIndex"])
            tx = x0 + (t / max_t) * cw
            line(tx, y0 + 2, tx, y0 + ch - 2, np.array([0.97, 0.46, 0.56]), 0.85)
    return np.clip(canvas * 255, 0, 255).astype(np.uint8)


def main() -> int:
    OUT.mkdir(exist_ok=True)
    state_dir = OUT / ".demo-state"
    sidecar = Sidecar(state_dir)
    try:
        sidecar.call("open", {"preset": "demo"})
        state = sidecar.call("state")
        # Put the crosshair on the strongest task voxel so the linked series shows
        # the block response rather than whatever voxel the centre of the head is.
        import nibabel as nib

        stats_img = nib.load(str(ROOT / "data" / "demo" / "stats.nii.gz"))
        tmap = np.asarray(stats_img.dataobj[..., 0], np.float32)
        func_img = nib.load(str(ROOT / "data" / "demo" / "func.nii.gz"))
        brain = np.asarray(func_img.dataobj[..., 0], np.float32) > 0
        tmap = np.where(brain, tmap, 0)
        peak = np.unravel_index(int(np.argmax(np.abs(tmap))), tmap.shape)
        peak_mm = (stats_img.affine @ np.array([*peak, 1.0]))[:3]
        sidecar.call("execute_batch", {"lines": [
            f"SET_XYZ {peak_mm[0]:.3f} {peak_mm[1]:.3f} {peak_mm[2]:.3f}",
            "SET_THRESHOLD S 2.5",
            "SET_ALPHA S off",
            "SET_SIGN S pos",
            "SET_COLORMAP S hot",
            "SET_RANGE S 2 6",
            "SET_VIEW_LOCKED V2 0",
            "SET_VIEW_POSITION V2 40",
            "SET_SURFACE_DEPTH S1 0.1 0.9 5",
            "SET_SURFACE_HEMIS S1 lh,rh 6",
            "SET_SURFACE_HINGE S1 25",
            "SET_VIEW_GRID G1 2",
        ], "origin": "ui"})
        state = sidecar.call("state")

        planes = {}
        for vid in ("V1", "V2", "V3"):
            result = sidecar.call("render", {"view": vid})
            images = decode_png(base64.b64decode(result["png"]))
            planes[vid] = (images, result)
            (OUT / f"demo_{vid}.png").write_bytes(base64.b64decode(result["png"]))

        # Threshold evidence: the same axial slice soloed on the statistic map at two
        # cuts. The cut, LUT and range are all computed by compose.render_plane.
        solo_images = []
        for threshold in (2.0, 4.0):
            sidecar.call("execute_batch", {"lines": [
                f"SET_THRESHOLD S {threshold}", "SET_VIEW_SOLO V1 1",
            ], "origin": "ui"})
            result = sidecar.call("render", {"view": "V1"})
            solo_images.append(decode_png(base64.b64decode(result["png"])))
        sidecar.call("execute", {"line": "SET_VIEW_SOLO V1 0", "origin": "ui"})
        sidecar.call("execute", {"line": "SET_THRESHOLD S 2.5", "origin": "ui"})
        h = max(image.shape[0] for image in solo_images)
        widths = [image.shape[1] for image in solo_images]
        threshold_canvas = np.zeros((h + 24, sum(widths) + 24, 4), np.uint8)
        threshold_canvas[..., :3] = BG[:3]
        threshold_canvas[..., 3] = 255
        x = 8
        for image in solo_images:
            blit(threshold_canvas, image, x, 12)
            x += image.shape[1] + 8
        (OUT / "demo_threshold.png").write_bytes(encode_rgba(threshold_canvas))

        # Surface mesh + FFS per-vertex colours. Show the map without a cut for the
        # screenshot so the sampling across cortex is visible; the slice evidence above
        # keeps the thresholded view.
        sidecar.call("execute_batch", {"lines": ["SET_THRESHOLD S 1.5", "SET_BOXED S 0", "SET_RANGE S -6 6", "SET_SIGN S both", "SET_COLORMAP S redblue"], "origin": "ui"})
        surface = sidecar.call("surface", {"view": "S1"})
        sidecar.call("execute_batch", {"lines": ["SET_THRESHOLD S 2.5", "SET_BOXED S 1", "SET_ALPHA S linear", "SET_SIGN S pos", "SET_COLORMAP S hot", "SET_RANGE S 2 6"], "origin": "ui"})
        colors = {item["hemi"]: item["rgba"] for item in surface["colors"]}
        surface_image = rasterize_surface(surface["mesh"], colors)
        (OUT / "demo_surface.png").write_bytes(encode_rgba(surface_image))

        # Linked time series at the crosshair.
        series = sidecar.call("series", {"view": "G1"})
        series_image = render_series(series)
        (OUT / "demo_series.png").write_bytes(encode_rgba(series_image))

        # Composite workspace evidence: slices left, surface right, series bottom.
        width, height = 1280, 720
        canvas = np.zeros((height, width, 4), np.uint8)
        canvas[..., :3] = BG[:3]
        canvas[..., 3] = 255
        cursor_x, cursor_y = 24, 24
        for vid in ("V1", "V2", "V3"):
            image, _ = planes[vid]
            scaled_w = 208
            scaled_h = int(round(image.shape[0] * (scaled_w / image.shape[1])))
            draw_border(canvas, cursor_x - 2, cursor_y - 2, scaled_w + 4, scaled_h + 4)
            blit(canvas, image, cursor_x, cursor_y, scale=scaled_w / image.shape[1])
            cursor_x += scaled_w + 18
        surface_x = max(cursor_x + 6, 690)
        draw_border(canvas, surface_x - 2, 22, surface_image.shape[1] + 4, surface_image.shape[0] + 4)
        blit(canvas, surface_image, surface_x, 24)
        draw_border(canvas, 22, 372, series_image.shape[1] + 4, series_image.shape[0] + 4)
        blit(canvas, series_image, 24, 374)
        (OUT / "demo_workspace.png").write_bytes(encode_rgba(canvas))
        print(json.dumps({
            "crosshair": state["crosshair"],
            "crosshairMm": state["crosshairMm"],
            "threshold": next(layer["threshold"] for layer in state["layers"] if layer["key"] == "S"),
            "files": [str(OUT / name) for name in (
                "demo_workspace.png", "demo_V1.png", "demo_V2.png", "demo_V3.png",
                "demo_surface.png", "demo_series.png",
            )],
        }, indent=2))
    finally:
        sidecar.close()
        import shutil

        shutil.rmtree(state_dir, ignore_errors=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
