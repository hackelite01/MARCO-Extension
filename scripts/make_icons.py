"""Generates the extension's icons: an orange rounded-square badge with a white voice-waveform
mark (original geometric design - fits "Marco" being a voice assistant). Pure Python, no image
library needed: draws at 4x supersample then box-filters down for clean anti-aliased edges.
"""
import struct
import zlib

ORANGE = (255, 122, 26)
WHITE = (255, 255, 255)
SS = 4  # supersample factor


def rounded_rect_inside(x, y, cx, cy, half_w, half_h, radius):
    # Standard rounded-box signed-distance function (Inigo Quilez's formula).
    qx = abs(x - cx) - (half_w - radius)
    qy = abs(y - cy) - (half_h - radius)
    ax, ay = max(qx, 0.0), max(qy, 0.0)
    outside_dist = (ax * ax + ay * ay) ** 0.5
    inside_dist = min(max(qx, qy), 0.0)
    return (outside_dist + inside_dist - radius) <= 0


def make_icon(size):
    hi = size * SS
    px = [[(0, 0, 0, 0)] * hi for _ in range(hi)]

    bg_r = hi * 0.30  # rounded-square corner radius
    for y in range(hi):
        for x in range(hi):
            if rounded_rect_inside(x + 0.5, y + 0.5, hi / 2, hi / 2, hi / 2, hi / 2, bg_r):
                px[y][x] = (*ORANGE, 255)

    # Voice-waveform bars: 5 vertical bars, varying heights, rounded caps.
    n = 5
    bar_w = hi * 0.085
    gap = hi * 0.06
    total_w = n * bar_w + (n - 1) * gap
    start_x = (hi - total_w) / 2
    heights = [0.42, 0.72, 1.0, 0.72, 0.42]
    max_h = hi * 0.56
    cy = hi / 2
    for i, hfrac in enumerate(heights):
        bh = max_h * hfrac
        bx = start_x + i * (bar_w + gap) + bar_w / 2
        cap = bar_w / 2
        for y in range(hi):
            for x in range(hi):
                if rounded_rect_inside(x + 0.5, y + 0.5, bx, cy, bar_w / 2, bh / 2, cap):
                    px[y][x] = (*WHITE, 255)

    # Box-filter downsample SS x SS -> size x size.
    out = []
    for y in range(size):
        row = []
        for x in range(size):
            r = g = b = a = 0
            for dy in range(SS):
                for dx in range(SS):
                    pr, pg, pb, pa = px[y * SS + dy][x * SS + dx]
                    r += pr * pa
                    g += pg * pa
                    b += pb * pa
                    a += pa
            n_samples = SS * SS
            if a > 0:
                r, g, b = r // a, g // a, b // a
            avg_a = a // n_samples
            row.append((r, g, b, avg_a))
        out.append(row)
    return out


def write_png(path, pixels):
    size = len(pixels)
    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filter: none
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))
    with open(path, "wb") as f:
        f.write(png)


if __name__ == "__main__":
    import pathlib
    out_dir = pathlib.Path(__file__).resolve().parent.parent / "extension"
    for size in (16, 48, 128):
        write_png(out_dir / f"icon{size}.png", make_icon(size))
        print(f"wrote icon{size}.png")
