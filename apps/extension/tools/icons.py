"""Build the extension's icons from the project's own Plip mark.

Pure standard library (zlib + struct), so there is nothing to install and the
icons are reproducible from assets/plip-icon-256.png, which keeps the
extension on the same mark as the Mac app.

    python3 apps/extension/tools/icons.py
"""
from __future__ import annotations

import struct
import sys
import zlib
from pathlib import Path

SOURCE = Path("assets/plip-icon-256.png")
OUT = Path("apps/extension/icons")
SIZES = (16, 32, 48, 128)


def read_rgba(path: Path) -> tuple[int, int, bytearray]:
    """Decode an 8-bit RGBA, non-interlaced PNG into a flat byte array."""
    raw = path.read_bytes()
    if raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise SystemExit(f"{path} is not a PNG")
    width = height = 0
    data = bytearray()
    pos = 8
    while pos < len(raw):
        (length,) = struct.unpack(">I", raw[pos:pos + 4])
        kind = raw[pos + 4:pos + 8]
        body = raw[pos + 8:pos + 8 + length]
        if kind == b"IHDR":
            width, height, depth, color, _, _, interlace = struct.unpack(">IIBBBBB", body)
            if (depth, color, interlace) != (8, 6, 0):
                raise SystemExit("icons.py expects an 8-bit RGBA, non-interlaced PNG")
        elif kind == b"IDAT":
            data += body
        elif kind == b"IEND":
            break
        pos += 12 + length
    return width, height, unfilter(zlib.decompress(bytes(data)), width, height)


def unfilter(stream: bytes, width: int, height: int) -> bytearray:
    stride = width * 4
    out = bytearray(stride * height)
    previous = bytearray(stride)
    pos = 0
    for row in range(height):
        kind = stream[pos]
        pos += 1
        line = bytearray(stream[pos:pos + stride])
        pos += stride
        for index in range(stride):
            left = line[index - 4] if index >= 4 else 0
            up = previous[index]
            upleft = previous[index - 4] if index >= 4 else 0
            if kind == 1:
                line[index] = (line[index] + left) & 0xFF
            elif kind == 2:
                line[index] = (line[index] + up) & 0xFF
            elif kind == 3:
                line[index] = (line[index] + (left + up) // 2) & 0xFF
            elif kind == 4:
                guess = left + up - upleft
                best = min((left, up, upleft), key=lambda value: abs(guess - value))
                line[index] = (line[index] + best) & 0xFF
            elif kind != 0:
                raise SystemExit(f"unknown PNG filter {kind}")
        out[row * stride:(row + 1) * stride] = line
        previous = line
    return out


def box_scale(pixels: bytearray, width: int, height: int, size: int) -> bytearray:
    """Average each destination pixel over its source block, alpha-weighted."""
    out = bytearray(size * size * 4)
    step_x = width / size
    step_y = height / size
    for y in range(size):
        y0, y1 = int(y * step_y), max(int(y * step_y) + 1, int((y + 1) * step_y))
        for x in range(size):
            x0, x1 = int(x * step_x), max(int(x * step_x) + 1, int((x + 1) * step_x))
            weight = red = green = blue = alpha = 0
            for sy in range(y0, min(y1, height)):
                row = sy * width * 4
                for sx in range(x0, min(x1, width)):
                    offset = row + sx * 4
                    a = pixels[offset + 3]
                    red += pixels[offset] * a
                    green += pixels[offset + 1] * a
                    blue += pixels[offset + 2] * a
                    alpha += a
                    weight += 1
            target = (y * size + x) * 4
            if alpha:
                out[target] = red // alpha
                out[target + 1] = green // alpha
                out[target + 2] = blue // alpha
            out[target + 3] = alpha // max(weight, 1)
    return out


def write_png(path: Path, pixels: bytearray, size: int) -> None:
    rows = b"".join(b"\x00" + bytes(pixels[row * size * 4:(row + 1) * size * 4]) for row in range(size))

    def chunk(kind: bytes, body: bytes) -> bytes:
        return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body))

    header = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(rows, 9))
        + chunk(b"IEND", b"")
    )


def main() -> int:
    if not SOURCE.is_file():
        print(f"missing {SOURCE}", file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    width, height, pixels = read_rgba(SOURCE)
    for size in SIZES:
        write_png(OUT / f"icon-{size}.png", box_scale(pixels, width, height, size), size)
        print(f"wrote {OUT / f'icon-{size}.png'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
