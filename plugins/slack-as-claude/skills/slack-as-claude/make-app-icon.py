r"""Render an emoji to a PNG suitable for a Slack app icon.

    python make-app-icon.py                       # robot face on dark slate
    python make-app-icon.py --emoji "\U0001F9EC"  # a different glyph
    python make-app-icon.py --bg "#CC785C"        # a different background
    python make-app-icon.py --out icon.png

Two things this exists to get right, both learned the hard way:

1. COLOUR EMOJI FONTS NEED embedded_color=True, ON AN RGBA TARGET.
   Segoe UI Emoji, Apple Color Emoji and Noto Color Emoji are bitmap (CBDT/sbix)
   fonts. Without embedded_color the glyph renders as a flat black silhouette -
   which looks like a legitimate icon until you see it beside a real emoji.
   They also only carry strikes at particular pixel sizes; 109pt is the size that
   works across all three, so draw large and downsample.

2. SLACK DOES NOT HONOUR TRANSPARENCY ON APP ICONS.
   It composites them onto white. A transparent PNG therefore arrives as a glyph
   floating on a white square, regardless of the viewer's theme. So the background
   is painted explicitly. Full-bleed square: Slack applies its own rounded mask,
   and baking in a corner radius would double-round.

Upload the result at api.slack.com/apps/<app id>/general -> Display Information ->
App icon, then Save Changes. Setting the icon there beats a per-message icon_emoji
override: it needs no chat:write.customize scope and applies everywhere the app
appears, including messages already sent.
"""
import argparse
import os
import sys

# ⚠ REQUIRES Pillow, and nothing in this repo declared it:  python -m pip install Pillow
from PIL import Image, ImageDraw, ImageFont

EMOJI_FONTS = [
    r"C:\Windows\Fonts\seguiemj.ttf",                     # Windows
    "/System/Library/Fonts/Apple Color Emoji.ttc",        # macOS
    "/usr/share/fonts/truetype/noto/NotoColorEmoji.ttf",  # Linux (Debian/Ubuntu)
    "/usr/share/fonts/noto-cjk/NotoColorEmoji.ttf",
    "/usr/share/fonts/google-noto-emoji/NotoColorEmoji.ttf",
]

# The size at which these bitmap fonts actually carry a strike.
STRIKE_PT = 109


def find_font(explicit=None):
    if explicit:
        if not os.path.exists(explicit):
            sys.exit(f"font not found: {explicit}")
        return explicit
    for path in EMOJI_FONTS:
        if os.path.exists(path):
            return path
    sys.exit(
        "no colour emoji font found. Pass --font with a path to one "
        "(Segoe UI Emoji, Apple Color Emoji, or Noto Color Emoji)."
    )


def parse_colour(value):
    v = value.lstrip("#")
    if len(v) != 6:
        sys.exit(f"--bg must be a 6-digit hex colour, got: {value}")
    try:
        return tuple(int(v[i:i + 2], 16) for i in (0, 2, 4)) + (255,)
    except ValueError:
        sys.exit(f"--bg is not valid hex: {value}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--emoji", default="\U0001F916", help="the glyph to render (default: robot face)")
    ap.add_argument("--bg", default="#2C2D30", help="background hex colour (default: #2C2D30)")
    ap.add_argument("--size", type=int, default=512, help="output square size in px (default: 512)")
    ap.add_argument("--coverage", type=float, default=0.72, help="fraction of the canvas the glyph fills")
    ap.add_argument("--font", help="path to a colour emoji font, if autodetection fails")
    ap.add_argument("--out", default="app-icon.png", help="output path")
    args = ap.parse_args()

    font = ImageFont.truetype(find_font(args.font), STRIKE_PT)

    tile = Image.new("RGBA", (STRIKE_PT * 2, STRIKE_PT * 2), (0, 0, 0, 0))
    ImageDraw.Draw(tile).text(
        (STRIKE_PT, STRIKE_PT), args.emoji, font=font, anchor="mm", embedded_color=True
    )

    bbox = tile.getbbox()
    if bbox is None:
        sys.exit("glyph rendered empty - the font has no bitmap strike at this size")
    glyph = tile.crop(bbox)

    target = int(args.size * args.coverage)
    scale = target / max(glyph.size)
    glyph = glyph.resize(
        (max(1, round(glyph.width * scale)), max(1, round(glyph.height * scale))),
        Image.LANCZOS,
    )

    canvas = Image.new("RGBA", (args.size, args.size), parse_colour(args.bg))
    canvas.paste(
        glyph,
        ((args.size - glyph.width) // 2, (args.size - glyph.height) // 2),
        glyph,  # mask, so the glyph's own alpha blends against the background
    )

    canvas.convert("RGB").save(args.out, "PNG")
    print(f"wrote {args.out}  {args.size}x{args.size}  bg={args.bg}")


if __name__ == "__main__":
    main()
