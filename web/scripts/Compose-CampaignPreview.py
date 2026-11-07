"""Compose a campaign preview from a source photo and a JSON layout plan."""

import json
import sys

from PIL import Image, ImageDraw, ImageFont, ImageOps, ImageStat


def box(values, width, height):
    x, y, w, h = values
    if min(x, y) < 0 or min(w, h) < 1 or x + w > width or y + h > height:
        raise ValueError("Layout box exceeds the canvas")
    return x, y, w, h


def wrap(draw, text, font, width):
    lines = []
    for paragraph in text.splitlines():
        words = paragraph.split()
        tokens = words if len(words) > 1 else list(paragraph)
        separator = " " if len(words) > 1 else ""
        line = ""
        for token in tokens:
            candidate = line + separator + token if line else token
            if line and draw.textlength(candidate, font=font) > width:
                lines.append(line)
                line = token
            else:
                line = candidate
        lines.append(line)
    return "\n".join(lines)


def backdrop_color(source, values):
    x, y, w, h = box(values, *source.size)
    sample = source.crop((x, y, x + w, y + h))
    if sample.mode == "RGBA" and sample.getchannel("A").getextrema()[0] != 255:
        raise ValueError("Choose an opaque backdrop sample")
    sample = sample.convert("RGB")
    if any(high - low > 24 for low, high in sample.getextrema()):
        raise ValueError("Choose a clean, evenly lit backdrop sample")
    return tuple(ImageStat.Stat(sample).median)


def sample_backdrop(source, sample):
    if sample is not None:
        return backdrop_color(source, sample)
    side = max(1, min(source.size) // 32)
    left = backdrop_color(source, (side, side, side, side))
    right = backdrop_color(source, (source.width - 2 * side, side, side, side))
    if any(abs(a - b) > 8 for a, b in zip(left, right)):
        raise ValueError("The upper corners differ. Provide a clean source backdrop sample")
    return tuple(round((a + b) / 2) for a, b in zip(left, right))


def extend_edge(canvas, edge, destination, size, fade_length, *, vertical, reverse):
    depth = size[1] if vertical else size[0]
    fade = Image.new("L", (1, depth))
    weights = []
    for offset in range(depth):
        distance = depth - 1 - offset if reverse else offset
        t = min(1, distance / fade_length)
        weights.append(round(255 * (1 - t * t * (3 - 2 * t))))
    fade.putdata(weights)
    if not vertical:
        fade = fade.transpose(Image.Transpose.TRANSPOSE)
    canvas.paste(
        edge.resize(size, Image.Resampling.NEAREST),
        destination,
        fade.resize(size, Image.Resampling.NEAREST),
    )


def extend_backdrop(photo, size, position, color):
    """Continue the studio backdrop outside the fitted photo's pixel bounds."""
    width, height = size
    left, top = position
    right = left + photo.width
    bottom = top + photo.height
    canvas = Image.new("RGB", size, color)
    canvas.paste(photo, position)
    fade_length = max(1, round(min(photo.size) / 3))

    # Extend rows first so the side columns continue naturally into the corners.
    if top:
        extend_edge(canvas, photo.crop((0, 0, photo.width, 1)), (left, 0),
                    (photo.width, top), fade_length, vertical=True, reverse=True)
    if bottom < height:
        extend_edge(canvas, photo.crop((0, photo.height - 1, photo.width, photo.height)), (left, bottom),
                    (photo.width, height - bottom), fade_length, vertical=True, reverse=False)
    if left:
        extend_edge(canvas, canvas.crop((left, 0, left + 1, height)), (0, 0),
                    (left, height), fade_length, vertical=False, reverse=True)
    if right < width:
        extend_edge(canvas, canvas.crop((right - 1, 0, right, height)), (right, 0),
                    (width - right, height), fade_length, vertical=False, reverse=False)
    return canvas


def compose(plan):
    width, height = plan["size"]
    photo_x, photo_y, photo_w, photo_h = box(plan["photo_box"], width, height)
    text_x, text_y, text_w, text_h = box(plan["text_box"], width, height)
    if (photo_x < text_x + text_w and text_x < photo_x + photo_w
            and photo_y < text_y + text_h and text_y < photo_y + photo_h):
        raise ValueError("Photo and text boxes overlap")

    mode = plan.get("background_mode", "solid")
    if mode not in ("solid", "extend"):
        raise ValueError("Use solid or extend background mode")
    with Image.open(plan["source"]) as image:
        source = ImageOps.exif_transpose(image).convert("RGBA")
    color = sample_backdrop(source, plan.get("backdrop_sample")) if mode == "extend" else plan["background"]
    photo = Image.new("RGB", source.size, color)
    photo.paste(source, mask=source.getchannel("A"))
    if plan.get("crop_box"):
        x, y, w, h = box(plan["crop_box"], *photo.size)
        photo = photo.crop((x, y, x + w, y + h))
    photo = ImageOps.contain(photo, (photo_w, photo_h), Image.Resampling.LANCZOS)
    position = (photo_x + (photo_w - photo.width) // 2, photo_y + (photo_h - photo.height) // 2)
    if mode == "extend":
        canvas = extend_backdrop(photo, (width, height), position, color)
    else:
        canvas = Image.new("RGB", (width, height), color)
        canvas.paste(photo, position)

    draw = ImageDraw.Draw(canvas)
    cursor = text_y
    minimum_type_size = max(18, round(min(width, height) * 0.022))
    for block in plan["text_blocks"]:
        if not block["text"].strip():
            continue
        if block["size"] < minimum_type_size:
            raise ValueError(f"Copy must be at least {minimum_type_size}px at this placement")
        font = ImageFont.truetype(block["font"], block["size"], index=block.get("font_index", 0))
        spacing = max(2, block["size"] // 5)
        lines = wrap(draw, block["text"], font, text_w)
        left, top, right, bottom = draw.multiline_textbbox((0, 0), lines, font=font, spacing=spacing)
        if right - left > text_w or cursor + bottom - top > text_y + text_h:
            raise ValueError("Copy does not fit the text box")
        draw.multiline_text((text_x - left, cursor - top), lines, font=font, spacing=spacing, fill=block["color"])
        cursor += bottom - top + block.get("gap_after", spacing * 2)
    canvas.save(plan["output"], "PNG")


if __name__ == "__main__":
    with open(sys.argv[1], encoding="utf-8") as stream:
        compose(json.load(stream))
