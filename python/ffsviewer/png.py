"""Minimal RGBA8 PNG encoder (standard library only)."""

from __future__ import annotations

import struct
import zlib

import numpy as np


def _chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def encode_rgba(rgba: np.ndarray, *, level: int = 1) -> bytes:
    """Encode an ``(H, W, 4)`` uint8 array as a PNG byte string."""
    arr = np.ascontiguousarray(rgba, dtype=np.uint8)
    if arr.ndim != 3 or arr.shape[2] != 4:
        raise ValueError(f"expected (H, W, 4) RGBA, got {arr.shape}")
    h, w = arr.shape[:2]
    # One filter byte (0 = none) per scanline, as PNG requires.
    raw = b"".join(b"\x00" + arr[y].tobytes() for y in range(h))
    header = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + _chunk(b"IHDR", header)
        + _chunk(b"IDAT", zlib.compress(raw, level))
        + _chunk(b"IEND", b"")
    )


def blank_rgba(width: int = 1, height: int = 1) -> np.ndarray:
    out = np.zeros((max(1, int(height)), max(1, int(width)), 4), np.uint8)
    return out
