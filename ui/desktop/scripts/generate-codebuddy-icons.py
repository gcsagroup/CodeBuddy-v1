"""Generate CodeBuddy PNG and Windows ICO assets from the distribution mark."""

from pathlib import Path

from PIL import Image, ImageDraw


IMAGES_DIR = Path(__file__).resolve().parent.parent / "src" / "images"
CANVAS_SIZE = 1024


def build_mark() -> Image.Image:
    image = Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0, 0))
    mask = Image.new("L", image.size, 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle((32, 32, 992, 992), radius=224, fill=255)

    gradient = Image.new("RGBA", image.size)
    gradient_pixels = gradient.load()
    start = (23, 37, 84)
    end = (7, 17, 31)
    for y in range(CANVAS_SIZE):
        ratio = y / (CANVAS_SIZE - 1)
        color = tuple(round(start[index] * (1 - ratio) + end[index] * ratio) for index in range(3))
        for x in range(CANVAS_SIZE):
            gradient_pixels[x, y] = (*color, 255)

    image.alpha_composite(Image.composite(gradient, Image.new("RGBA", image.size), mask))
    draw = ImageDraw.Draw(image)
    cyan = (103, 232, 249, 255)
    lime = (163, 230, 53, 255)
    draw.line([(348, 284), (184, 512), (348, 740)], fill=cyan, width=84, joint="curve")
    draw.line([(676, 284), (840, 512), (676, 740)], fill=cyan, width=84, joint="curve")
    draw.line([(572, 256), (452, 768)], fill=lime, width=68)
    return image


def main() -> None:
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)
    mark = build_mark()
    mark.save(IMAGES_DIR / "icon.png")
    mark.resize((512, 512), Image.Resampling.LANCZOS).save(IMAGES_DIR / "icon-512.png")
    mark.resize((2048, 2048), Image.Resampling.LANCZOS).save(IMAGES_DIR / "icon@2x.png")
    mark.save(
        IMAGES_DIR / "icon.ico",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )


if __name__ == "__main__":
    main()
