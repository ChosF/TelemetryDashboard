"""Process sponsor logo assets for the Patrocinadores page."""

from __future__ import annotations

import shutil
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SPONSORS = ROOT / "public" / "images" / "sponsors"
DOWNLOADS = Path.home() / "Downloads"


def is_green(r: int, g: int, b: int) -> bool:
    return g > 90 and g > r + 20 and g > b + 10


def is_dark(r: int, g: int, b: int, alpha: int, threshold: int = 45) -> bool:
    return alpha > 180 and r < threshold and g < threshold and b < threshold


def content_bbox(im: Image.Image, brightness: int = 35) -> tuple[int, int, int, int]:
    px = im.load()
    xs: list[int] = []
    ys: list[int] = []
    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            if a > 20 and (r + g + b) / 3 > brightness:
                xs.append(x)
                ys.append(y)
    if not xs:
        return 0, 0, im.width - 1, im.height - 1
    return min(xs), min(ys), max(xs), max(ys)


def replace_altair() -> None:
    src = DOWNLOADS / "altair.png"
    dst = SPONSORS / "altair.png"
    shutil.copy2(src, dst)
    print(f"altair: copied {src.name} -> {dst.name}")


def find_leaf_start(im: Image.Image) -> int:
    px = im.load()
    for x in range(int(im.width * 0.55), im.width):
        green_count = 0
        for y in range(im.height):
            r, g, b, a = px[x, y]
            if a > 180 and is_green(r, g, b):
                green_count += 1
        if green_count > 20:
            return x - 4
    return int(im.width * 0.78)


def process_ecopoxy() -> None:
    src = SPONSORS / "ecopoxy-source.png"
    if not src.exists():
        raise FileNotFoundError(f"Missing {src}")

    im = Image.open(src).convert("RGBA")
    px = im.load()
    leaf_cutout_start = find_leaf_start(im)

    for y in range(im.height):
        for x in range(im.width):
            r, g, b, a = px[x, y]
            if not is_dark(r, g, b, a):
                continue
            if x >= leaf_cutout_start:
                px[x, y] = (0, 0, 0, 0)
            else:
                px[x, y] = (255, 255, 255, a)

    x0, y0, x1, y1 = content_bbox(im, brightness=20)
    cropped = im.crop((x0, y0, x1 + 1, y1 + 1))
    target_width = 680
    scale = target_width / cropped.width
    target_height = max(1, round(cropped.height * scale))
    resized = cropped.resize((target_width, target_height), Image.Resampling.LANCZOS)

    out = SPONSORS / "ecopoxy.png"
    resized.save(out, optimize=True)
    print(f"ecopoxy: leaf split at x={leaf_cutout_start} -> {out.name} ({resized.size[0]}x{resized.size[1]})")


def process_gacars() -> None:
    src = DOWNLOADS / "gacar.png"
    if not src.exists():
        raise FileNotFoundError(f"Missing {src}")

    out = SPONSORS / "gacars.png"
    shutil.copy2(src, out)
    print(f"gacars: copied {src.name} -> {out.name} (no processing)")


def crop_and_scale(
    src_name: str,
    dst_name: str,
    *,
    crop_box: tuple[int, int, int, int] | None = None,
    scale: float = 2.0,
    brighten: bool = False,
) -> None:
    src = SPONSORS / src_name
    im = Image.open(src).convert("RGBA")

    if crop_box is None:
        x0, y0, x1, y1 = content_bbox(im)
        crop_box = (x0, y0, x1 + 1, y1 + 1)

    cropped = im.crop(crop_box)
    new_size = (
        max(1, round(cropped.width * scale)),
        max(1, round(cropped.height * scale)),
    )
    resized = cropped.resize(new_size, Image.Resampling.LANCZOS)

    if brighten:
        px = resized.load()
        for y in range(resized.height):
            for x in range(resized.width):
                r, g, b, a = px[x, y]
                if a < 20:
                    continue
                if is_dark(r, g, b, a, threshold=80):
                    px[x, y] = (245, 245, 245, a)
                elif (r + g + b) / 3 < 170:
                    px[x, y] = (
                        min(255, int(r * 1.6)),
                        min(255, int(g * 1.6)),
                        min(255, int(b * 1.6)),
                        a,
                    )

    out = SPONSORS / dst_name
    resized.save(out, optimize=True)
    print(f"{dst_name}: cropped {crop_box}, scale {scale}x -> {new_size}")


def main() -> None:
    replace_altair()
    process_ecopoxy()
    process_gacars()
    crop_and_scale("shell-quaker-state-source.png", "shell-quaker-state.png", scale=2.4)


if __name__ == "__main__":
    main()
