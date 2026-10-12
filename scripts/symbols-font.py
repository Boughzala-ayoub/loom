"""Builds src/fonts/loom-symbols.woff, the phone's font for the symbols agents
draw (⏵ ⎿ ✻ ← ▛ ⠋ ...): a phone's own fonts drew ⏵ and ← as boxes.
Cut from JuliaMono (OFL, 0.6 em like every terminal font), renamed as its
Reserved Font Name asks of a changed copy. Emoji that draw in colour by
default stay out, for the phone's emoji font. src/remote.css names the ranges.

python scripts/symbols-font.py JuliaMono-Regular.ttf emoji-data.txt
(github.com/cormullion/juliamono, unicode.org/Public/16.0.0/ucd/emoji)
"""
import sys
from fontTools import subset
from fontTools.ttLib import TTFont

RANGES = [(0x2190, 0x21FF), (0x2300, 0x23FF), (0x2500, 0x27BF), (0x27F0, 0x28FF), (0x2900, 0x297F), (0x29C0, 0x29FF), (0x2B00, 0x2BFF)]

font_path, emoji_path = sys.argv[1:3]
colour = set()
for line in open(emoji_path, encoding="utf-8"):
    if "; Emoji_Presentation" in line:
        lo, _, hi = line.split(";")[0].strip().partition("..")
        colour.update(range(int(lo, 16), int(hi or lo, 16) + 1))
wanted = [c for lo, hi in RANGES for c in range(lo, hi + 1) if c not in colour]

font = TTFont(font_path)
options = subset.Options(flavor="woff", layout_features=[], hinting=False, name_IDs=[0, 1, 2, 3, 4, 5, 6, 13, 14])
subsetter = subset.Subsetter(options)
subsetter.populate(unicodes=wanted)
subsetter.subset(font)
for record in font["name"].names:
    if record.nameID in (1, 3, 4, 6):
        record.string = "LoomSymbols" if record.nameID == 6 else "Loom Symbols"
font.flavor = "woff"
font.save("src/fonts/loom-symbols.woff")
print(len(font.getBestCmap()), "symbols")
