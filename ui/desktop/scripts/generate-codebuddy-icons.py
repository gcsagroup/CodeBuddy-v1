"""Export desktop icon formats from the checked-in CodeBuddy artwork (Pillow)."""
import base64
import io
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps

DESKTOP = Path(__file__).resolve().parent.parent
IMAGES_DIR = DESKTOP / "src" / "images"
BRANDING_DIR = DESKTOP / "branding"


def resized(image: Image.Image, size: int) -> Image.Image:
    # Fit instead of stretching if a future source includes asymmetric margins.
    fitted = ImageOps.contain(image, (size, size), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size))
    canvas.alpha_composite(fitted, ((size - fitted.width) // 2, (size - fitted.height) // 2))
    return canvas


def svg_wrapper(image: Image.Image, destination: Path) -> None:
    # Embed the same artwork, rather than trace a different brand mark.
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    data = base64.b64encode(buffer.getvalue()).decode("ascii")
    destination.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" '
        'viewBox="0 0 512 512"><image width="512" height="512" '
        f'href="data:image/png;base64,{data}"/></svg>\n', encoding="utf-8"
    )


def with_update_badge(image: Image.Image, *, template: bool) -> Image.Image:
    # The badge is status chrome; the underlying artwork is unchanged.
    result = image.copy()
    size = result.width
    draw = ImageDraw.Draw(result)
    bounds = tuple(round(value * size) for value in (0.71, 0.04, 0.98, 0.31))
    draw.ellipse(bounds, fill="black" if template else "#FBBF24",
                 outline=(0, 0, 0, 0) if template else "#202020",
                 width=max(1, round(size * 0.025)))
    return result


def main() -> None:
    mark = Image.open(BRANDING_DIR / "codebuddy-master.png").convert("RGBA")
    template = Image.open(BRANDING_DIR / "codebuddy-template-master.png").convert("RGBA")
    for name, size in {
        "icon.png": 1024, "icon@2x.png": 2048, "icon-512.png": 512,
        "icon-light.png": 1024, "mark.png": 128, "mark@2x.png": 256,
        "favicon.png": 32,
    }.items():
        resized(mark, size).save(IMAGES_DIR / name)
    resized(mark, 1024).save(IMAGES_DIR / "icon.icns", format="ICNS")
    (IMAGES_DIR / "icon-light.icns").write_bytes((IMAGES_DIR / "icon.icns").read_bytes())
    sizes = [(s, s) for s in (16, 20, 24, 32, 40, 48, 64, 128, 256)]
    resized(mark, 256).save(IMAGES_DIR / "icon.ico", sizes=sizes,
                           append_images=[resized(mark, s) for s, _ in sizes])
    update = with_update_badge(mark, template=False)
    resized(update, 256).save(IMAGES_DIR / "iconUpdate.ico", sizes=sizes,
                             append_images=[resized(update, s) for s, _ in sizes])
    svg_wrapper(resized(mark, 512), IMAGES_DIR / "icon.svg")
    svg_wrapper(resized(template, 512), IMAGES_DIR / "glyph.svg")
    for suffix, size in (("", 22), ("@2x", 44)):
        resized(template, size).save(IMAGES_DIR / f"iconTemplate{suffix}.png")
        resized(with_update_badge(template, template=True), size).save(
            IMAGES_DIR / f"iconTemplateUpdate{suffix}.png")
    resized(with_update_badge(mark, template=False), 128).save(IMAGES_DIR / "iconUpdate.png")
    print("Exported CodeBuddy PNG, ICO, ICNS, SVG wrappers and tray icons.")


if __name__ == "__main__":
    main()
