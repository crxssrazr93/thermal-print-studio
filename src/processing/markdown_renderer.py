# markdown renderer for thermal output
#
# Deliberately hand-rolled rather than markdown -> HTML -> raster. A 1-bit strip
# a few hundred dots wide has no use for most of HTML, and every rendering
# decision here is about what survives at 203 dpi: weight instead of colour,
# rules instead of margins, monospace instead of syntax highlighting.

import logging
import re
from dataclasses import dataclass, field, replace
from typing import List, Optional, Tuple

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from ..config.defaults import (
    DEFAULT_LINE_SPACING,
    RTL_FALLBACK_FONTS,
    SYMBOL_FALLBACK_FONTS,
)
from ..config.printer_profile import get_printer_width
from ..utils.font_manager import get_font_manager
from .image_dither import dither_image
from .math_renderer import render_math

logger = logging.getLogger(__name__)

# Heading sizes as multipliers of the body size. Thermal heads lose thin
# strokes, so headings are bold as well as larger.
HEADING_SCALE = {1: 1.6, 2: 1.35, 3: 1.15, 4: 1.0, 5: 1.0, 6: 1.0}

BULLETS = ["\u2022", "-", "*"]  # only glyphs the mono faces reliably carry

# How a page is set, as opposed to what it says. A theme supplies a partial
# override of this; anything it leaves out keeps the default, so a theme can be
# as light a touch as one different bullet.
DEFAULT_PRINT_STYLE = {
    "heading_case": "none",      # none | upper
    "heading_align": "left",     # left | center
    "heading_banner": False,     # set a level 1 heading white out of a black bar
    "heading_scale": 1.0,        # multiplier on top of HEADING_SCALE
    "rule_style": "solid",       # solid | double | dotted | none
    "rule_weight": 3,            # dots thick, for a level 1 heading rule
    "bullet": "\u2022",
    "table_rule": "dotted",      # dotted | solid | none
    "table_header_rule": 2,
    "quote_bar": 3,              # dots wide; 0 draws no bar
    "quote_italic": True,
    "block_gap": 6,              # blank dots between two paragraphs
    "margin": 6,                 # dots of white down each side of the page
    "margin_top": 6,
    "margin_bottom": 6,
    "rule_gap_above": 4,         # between heading text and its rule
    "heading_gap": 8,            # between that rule and whatever follows
    "list_indent": 14,           # the bullet, inset from the margin
    "list_gap": 8,               # around a list as a whole
    "list_item_gap": 3,          # between two items of one list
    "quote_gap": 10,             # around a quote
    "quote_pad": 12,             # the text, inset from the bar
    "table_gap": 12,             # around a table
    "table_scale": 0.9,          # cell size as a fraction of the body
    "table_cell_pad": 4,         # above and below the text in a cell
    "image_dither": "floyd-steinberg",   # how a picture becomes ink or nothing
    "image_threshold": 128,      # the cutoff: how much of it becomes ink at all
    "image_strength": 1.0,       # how much of the error is diffused, 0 to 1
    "image_prefilter": "none",   # what is done to the picture before screening
    # Arabic and Hebrew need a face that carries the script and a shaper that
    # joins it; most mono faces carry neither, so a right to left run is set in
    # this family instead of the theme's.
    "rtl_font": "DejaVuSansMono",
}

_INLINE_CODE = re.compile(r"`([^`]+)`")
# Text pasted from a web page, particularly an Arabic or Hebrew one, carries
# invisible direction marks: left to right and right to left marks, isolates,
# embeddings. They are characters like any other as far as a regular expression
# is concerned, so one landing between the "!" and the "[" of an image is enough
# to stop it being an image at all, and the markdown prints as text. They are
# tolerated inside the syntax here and stripped out of what is captured.
_BIDI_MARKS = "\u200e\u200f\u061c\u2066\u2067\u2068\u2069\u202a-\u202e"
_BIDI = re.compile(f"[{_BIDI_MARKS}]")
_GAP = f"[{_BIDI_MARKS}]*"

_LINK = re.compile(rf"{_GAP}\[([^\]]+)\]{_GAP}\({_GAP}([^)]+)\)")
_IMAGE = re.compile(rf"!{_GAP}\[([^\]]*)\]{_GAP}\({_GAP}([^)]+)\)")


def strip_bidi(text: str) -> str:
    """Drop the invisible direction marks. For paths and syntax, never prose."""
    return _BIDI.sub("", text or "")
_TABLE_DIRECTIVE = re.compile(r"<!--\s*table\s+(.*?)\s*-->")

# Arabic, Hebrew, Syriac, Thaana and the Arabic supplements. Enough to decide
# which way a line runs, which is all this needs to know.
_RTL_RANGE = re.compile(
    "[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0780-\u07BF"
    "\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]"
)


def is_rtl(text: str) -> bool:
    return bool(_RTL_RANGE.search(text or ""))


def _parse_directive(body: str) -> dict:
    return dict(
        part.split("=", 1) for part in body.split() if "=" in part
    )


def _parse_shares(value: str) -> List[int]:
    """Column widths as percentages, as dragged in the editor.

    Widths are a view concern right up until someone deliberately sets them,
    at which point they are a decision about the page and belong on the paper
    too. Anything malformed is simply ignored and the table sizes itself.
    """
    try:
        shares = [int(part) for part in value.split(",") if part.strip()]
    except ValueError:
        return []
    return shares if shares and all(share > 0 for share in shares) else []


_FILENAME = re.compile(
    r"^[\w .()\[\]-]{1,64}\.(?:png|jpe?g|gif|webp|bmp|tiff?|avif|heic)$",
    re.IGNORECASE,
)


def _image_label(alt: str) -> str:
    alt = strip_bidi(alt or "").strip()
    return "[image]" if not alt or _looks_like_filename(alt) else f"[{alt}]"


def _looks_like_filename(text: str) -> bool:
    """True for "photo 3.png" and the like: a name, not a description."""
    return bool(_FILENAME.match(text.strip()))


def _split_image_target(target: str) -> Tuple[str, str]:
    """Separate a source from markdown's optional title.

    The title is where a per-image choice lives: ![alt](path "atkinson"), which
    stays valid markdown and is ignored by anything that does not care.
    """
    target = strip_bidi(target).strip()
    match = re.match(r'^(?P<src>\S+)(?:\s+"(?P<title>[^"]*)")?$', target)
    if not match:
        return target, ""
    return match.group("src"), (match.group("title") or "").strip()


def _cell_alignment(cell: str) -> str:
    left, right = cell.startswith(":"), cell.endswith(":")
    if left and right:
        return "center"
    if right:
        return "right"
    return "left"


@dataclass
class Span:
    """A run of text sharing one style."""
    text: str
    bold: bool = False
    italic: bool = False
    mono: bool = False
    underline: bool = False
    strike: bool = False        # a rule through the middle of the letters
    highlight: bool = False     # printed as white out of black, which a head does well
    raise_: int = 0             # +1 superscript, -1 subscript


@dataclass
class Block:
    kind: str                      # paragraph | heading | list | code | quote | rule | table | math | image
    spans: List[Span] = field(default_factory=list)
    level: int = 0                 # heading level, list depth
    ordered: bool = False
    index: int = 0                 # ordered list counter
    rows: List[List[str]] = field(default_factory=list)   # table only
    align: List[str] = field(default_factory=list)        # table only: left|center|right
    borders: str = ""                                     # table only: all|header|none
    shares: List[int] = field(default_factory=list)       # table only: column widths, in percent
    lines: List[str] = field(default_factory=list)        # code only


class MarkdownRenderer:
    """Renders a markdown subset to a 1-bit friendly greyscale image."""

    def __init__(
        self,
        width: Optional[int] = None,
        font_family: str = "DejaVu Sans Mono",
        font_size: int = 24,
        line_spacing: Optional[float] = None,
        margin: int = 6,
        style: Optional[dict] = None,
        image_root: Optional[Path] = None,
    ):
        self.width = width if width is not None else get_printer_width()
        self.font_family = font_family
        self.font_size = font_size
        self.line_spacing = line_spacing if line_spacing is not None else DEFAULT_LINE_SPACING
        self.style = {**DEFAULT_PRINT_STYLE, **(style or {})}
        self.margin = int(self.style["margin"]) if margin == 6 else margin
        self._fm = get_font_manager()
        self._style_cache = {}
        self._x_heights = {}
        # where /images/<name> references resolve to; without one an image
        # falls back to its alt text, which is what the desktop app wants
        self.image_root = Path(image_root) if image_root else None

    # -------------------------------------------------------------------------
    # TextRenderer-compatible surface
    #
    # BaseTextFrame drives whichever renderer it holds, so matching that small
    # interface lets the markdown tab reuse the whole existing frame - font
    # controls, preview, gallery, print - instead of duplicating it.
    # -------------------------------------------------------------------------
    def update_font(self, font_family: str = None, font_size: int = None,
                    bold: bool = False, italic: bool = False) -> None:
        if font_family:
            self.font_family = font_family
        if font_size:
            self.font_size = int(font_size)

    def set_alignment(self, alignment: str) -> None:
        # markdown carries its own block structure; a global alignment would
        # fight it, so this is accepted and ignored
        pass

    def set_wrap(self, wrap: bool) -> None:
        pass

    # -------------------------------------------------------------------------
    # fonts
    # -------------------------------------------------------------------------
    # Bold and italic come from the family's own files when it has them. When
    # it does not, the face it does have is thickened or slanted here, so the
    # page stays in the typeface that was chosen: swapping in another family's
    # italic changes the letters mid sentence, and handing back regular for
    # bold prints the emphasis as if it were not there.
    _STYLE_NAMES = {(False, False): "Regular", (True, False): "Bold",
                    (False, True): "Italic", (True, True): "BoldItalic"}
    SLANT = 0.21          # the shear of a synthetic italic, about 12 degrees

    def _family_key(self, family: str) -> Optional[str]:
        """The family as the font manager indexed it, or None if it has no files."""
        for candidate in (family, family.replace(" ", "")):
            if self._fm.get_family_styles(candidate):
                return candidate
        return None

    def _font(self, size: int, bold: bool = False, italic: bool = False, mono: bool = False):
        family = "DejaVu Sans Mono" if mono else self.font_family
        key = (family, size, bold, italic)
        if key not in self._style_cache:
            self._style_cache[key] = self._styled_font(family, size, bold, italic)
        return self._style_cache[key]

    def _styled_font(self, family: str, size: int, bold: bool, italic: bool):
        known = self._family_key(family)
        if known is None:
            # not an installed family at all; the font manager's own fallback
            # is the best there is, and there is no face to synthesise from
            return (self._fm.load_font(family, size, bold=bold, italic=italic)
                    or self._fm.load_font(family, size))

        # the nearest real face: for bold italic a real italic is kept over a
        # real bold, since italic letterforms differ and weight is easy to add
        wanted = [(bold, italic)]
        if bold and italic:
            wanted += [(False, True), (True, False)]
        wanted.append((False, False))

        styles = set(self._fm.get_family_styles(known))
        for real_bold, real_italic in wanted:
            if self._STYLE_NAMES[(real_bold, real_italic)] in styles:
                break
        else:
            real_bold, real_italic = bold, italic   # whatever file it has, as is
        path = self._fm.get_font_path(
            known, self._STYLE_NAMES[(real_bold, real_italic)], fallback=False)
        try:
            font = ImageFont.truetype(path, size)
        except (OSError, TypeError):
            return self._fm.load_font(family, size)
        font.faux_bold = bold and not real_bold
        font.faux_slant = italic and not real_italic
        return font

    @staticmethod
    def _embolden(font) -> int:
        """Extra dots of weight for a synthetic bold: two at body size."""
        return max(1, round(getattr(font, "size", 24) / 16))

    def _line_height(self, font) -> int:
        try:
            ascent, descent = font.getmetrics()
            base = ascent + descent
        except (AttributeError, OSError):
            base = int(self.font_size * 1.2)
        return max(1, int(base * self.line_spacing))

    # -------------------------------------------------------------------------
    # parsing
    # -------------------------------------------------------------------------
    def parse(self, text: str) -> List[Block]:
        blocks: List[Block] = []
        lines = text.replace("\r\n", "\n").split("\n")
        i = 0
        ordered_counter = 0
        pending_directive: dict = {}

        while i < len(lines):
            raw = lines[i]
            stripped = raw.strip()

            # fenced code
            if stripped.startswith("```"):
                code: List[str] = []
                i += 1
                while i < len(lines) and not lines[i].strip().startswith("```"):
                    code.append(lines[i])
                    i += 1
                i += 1
                blocks.append(Block(kind="code", lines=code))
                continue

            if not stripped:
                # a deliberate blank line is a line of space, not nothing: it
                # is what the author typed and what the editor shows
                blocks.append(Block(kind="space"))
                i += 1
                ordered_counter = 0
                continue

            # display math - $$ ... $$ on its own lines
            if stripped.startswith("$$"):
                math_lines = [stripped[2:]]
                if not stripped.endswith("$$") or len(stripped) < 4:
                    i += 1
                    while i < len(lines) and not lines[i].strip().endswith("$$"):
                        math_lines.append(lines[i])
                        i += 1
                    if i < len(lines):
                        math_lines.append(lines[i].strip().rstrip("$"))
                else:
                    math_lines = [stripped[2:-2]]
                i += 1
                blocks.append(Block(kind="math", lines=[" ".join(math_lines).strip()]))
                continue

            # horizontal rule
            if re.fullmatch(r"(\s*[-*_]\s*){3,}", raw):
                blocks.append(Block(kind="rule"))
                i += 1
                continue

            # a directive is a comment carrying the choices markdown has no
            # syntax for, so a table can remember how it was set without the
            # document stopping being markdown
            directive = _TABLE_DIRECTIVE.match(stripped)
            if directive:
                pending_directive = _parse_directive(directive.group(1))
                i += 1
                continue

            # table - a header row followed by a separator of dashes
            if "|" in stripped and i + 1 < len(lines) and re.fullmatch(
                r"\s*\|?[\s:|-]+\|?\s*", lines[i + 1]
            ) and "-" in lines[i + 1]:
                rows = []
                align: List[str] = []
                while i < len(lines) and "|" in lines[i]:
                    body = lines[i].strip().strip("|")
                    cells = [c.strip() for c in body.split("|")]
                    if re.fullmatch(r"[\s:|-]+", body):
                        align = [_cell_alignment(c) for c in cells]
                    else:
                        rows.append(cells)
                    i += 1
                blocks.append(Block(
                    kind="table", rows=rows, align=align,
                    borders=pending_directive.get("borders", ""),
                    shares=_parse_shares(pending_directive.get("widths", "")),
                ))
                pending_directive = {}
                continue

            # A picture is a block whatever else shares its line. Markdown calls
            # an image inline, but a thermal page is one column wide and there
            # is nowhere for a picture to sit beside a sentence, so a line that
            # holds one is split: the words before it, the picture, the words
            # after. Typing a picture into the middle of a paragraph is how
            # anyone actually inserts one, and it used to print as its own
            # markup.
            if _IMAGE.search(stripped):
                blocks.extend(self._split_around_images(stripped))
                i += 1
                continue

            # heading
            heading = re.match(r"(#{1,6})\s+(.*)", stripped)
            if heading:
                blocks.append(Block(
                    kind="heading",
                    level=len(heading.group(1)),
                    spans=self._parse_inline(heading.group(2)),
                ))
                i += 1
                continue

            # blockquote
            if stripped.startswith(">"):
                blocks.append(Block(
                    kind="quote",
                    spans=self._parse_inline(stripped.lstrip("> ").strip()),
                ))
                i += 1
                continue

            # lists
            indent = len(raw) - len(raw.lstrip(" "))
            bullet = re.match(r"[-*+]\s+(.*)", stripped)
            numbered = re.match(r"(\d+)[.)]\s+(.*)", stripped)

            if bullet:
                task = re.match(r"\[([ xX])\]\s+(.*)", bullet.group(1))
                blocks.append(Block(
                    kind="list", level=indent // 2,
                    # the box is drawn rather than written, so it survives a
                    # font that has no ballot glyphs
                    borders=("done" if task and task.group(1).lower() == "x"
                             else "todo" if task else ""),
                    spans=self._parse_inline(task.group(2) if task else bullet.group(1)),
                ))
                i += 1
                continue

            if numbered:
                ordered_counter += 1
                blocks.append(Block(
                    kind="list", level=indent // 2, ordered=True,
                    index=ordered_counter,
                    spans=self._parse_inline(numbered.group(2)),
                ))
                i += 1
                continue

            # paragraph - one block per typed line
            #
            # Markdown proper joins consecutive lines into one paragraph, but
            # that convention exists for source files that get re-flowed later.
            # Here the user is typing what a receipt should look like, so a
            # newline is a line break. Long lines still soft-wrap to the paper.
            blocks.append(Block(kind="paragraph", spans=self._parse_inline(stripped)))
            i += 1

        return blocks

    def _split_around_images(self, line: str) -> List[Block]:
        """One line holding a picture becomes text, picture, text."""
        blocks: List[Block] = []
        position = 0
        for match in _IMAGE.finditer(line):
            before = line[position:match.start()].strip()
            if before:
                blocks.append(Block(kind="paragraph", spans=self._parse_inline(before)))
            source, title = _split_image_target(match.group(2))
            blocks.append(Block(
                kind="image",
                lines=[source],
                spans=[Span(strip_bidi(match.group(1)))],
                borders=title,              # the per-image dither, if it named one
            ))
            position = match.end()

        rest = line[position:].strip()
        if rest:
            blocks.append(Block(kind="paragraph", spans=self._parse_inline(rest)))
        return blocks

    def _parse_inline(self, text: str) -> List[Span]:
        """Flatten inline markup into styled spans.

        Links become "text (url)" because a printed page cannot be clicked, and
        dropping the target would lose information the reader needs.
        """
        # Images are lifted out into blocks before this runs, so anything left
        # here is a picture that could not be one: name it plainly, and never
        # with its path.
        text = _IMAGE.sub(lambda m: _image_label(m.group(1)), text)
        text = _LINK.sub(lambda m: f"{m.group(1)} ({m.group(2)})", text)
        return self._inline_spans(text, {}) or [Span(text)]

    # Emphasis must not fire mid-word. Markdown allows intraword "*", but on a
    # printer the input is as often plain text as markup, and silently italicising
    # the 3 in "2*3*4" or the middle of "some_var_name" corrupts what was typed.
    # Requiring a non-word character on both sides keeps prose literal.
    #
    # Markers nest, so a run is parsed again inside its markers with their style
    # added: "**bold ++under++**" is bold throughout and underlined at the end,
    # rather than bold with the plus signs printed. Code is the one exception,
    # since everything inside backticks is meant literally.
    _INLINE = re.compile(
        r"(?P<code>`[^`]+`)|(?P<both>(?<!\w)\*\*\*.+?\*\*\*(?!\w))|"
        r"(?P<bold>(?<!\w)(?:\*\*|__).+?(?:\*\*|__)(?!\w))|"
        r"(?P<strike>~~.+?~~)|"
        r"(?P<mark>==[^=]+==)|(?P<under>\+\+[^+]+\+\+)|"
        r"(?P<sup>\^[^\^\s]+\^)|(?P<sub>(?<!~)~[^~\s]+~(?!~))|"
        r"(?P<italic>(?<![\w\*_])[\*_][^\*_\s][^\*_]*?[\*_](?![\w\*_]))"
    )
    # how many marker characters each side, and the style they add
    _INLINE_STYLE = {
        "both": (3, {"bold": True, "italic": True}),
        "bold": (2, {"bold": True}),
        "strike": (2, {"strike": True}),
        "mark": (2, {"highlight": True}),
        "under": (2, {"underline": True}),
        "sup": (1, {"raise_": 1}),
        "sub": (1, {"raise_": -1}),
        "italic": (1, {"italic": True}),
    }

    def _inline_spans(self, text: str, style: dict) -> List[Span]:
        spans: List[Span] = []
        position = 0
        for match in self._INLINE.finditer(text):
            if match.start() > position:
                spans.append(Span(text[position:match.start()], **style))
            kind = match.lastgroup
            body = match.group(kind)
            if kind == "code":
                spans.append(Span(body[1:-1], **{**style, "mono": True}))
            else:
                trim, added = self._INLINE_STYLE[kind]
                spans.extend(self._inline_spans(body[trim:-trim], {**style, **added}))
            position = match.end()
        if position < len(text):
            spans.append(Span(text[position:], **style))
        return spans

    # -------------------------------------------------------------------------
    # layout
    # -------------------------------------------------------------------------
    def _wrap_spans(self, spans: List[Span], font_size: int, available: int,
                    force_bold: bool = False, force_italic: bool = False
                    ) -> List[List[Tuple[Span, str, object]]]:
        """Greedy word wrap that keeps per-word styling.

        Whatever the line will be drawn in has to be what it is measured in.
        A quote is set in italic, and the oblique face borrowed for that is not
        the width of the upright one: measured upright and drawn slanted, a
        line that just fitted runs off the edge of the paper.
        """
        lines: List[List[Tuple[Span, str, object]]] = [[]]
        x = 0

        for span in spans:
            font = self._font(font_size, span.bold or force_bold,
                              span.italic or force_italic, span.mono)
            if font is None:
                continue
            for word in re.findall(r"\s+|\S+", span.text) or []:
                if word.isspace() and not lines[-1]:
                    continue  # no leading space at the start of a wrapped line
                word_width = self._text_width(word, font, font_size)

                if x + word_width > available and lines[-1]:
                    lines.append([])
                    x = 0
                    word = word.lstrip()
                    if not word:
                        continue
                    word_width = self._text_width(word, font, font_size)

                lines[-1].append((span, word, font))
                x += word_width

        return [line for line in lines if line] or [[]]

    def render(self, text: str, max_height: int = 20000) -> Image.Image:
        blocks = self.parse(text)
        width = self.width
        body = self.margin

        # Every right to left run in the document is set in one face, chosen
        # against all of them together: a page where one verse is in the mono
        # face and the next in Naskh, because only the second happens to carry
        # a pause mark, reads as a mistake.
        self._rtl_corpus = "".join(
            "".join(span.text for span in block.spans)
            for block in blocks
            if block.spans and is_rtl("".join(span.text for span in block.spans))
        )

        image = Image.new("RGB", (width, max_height), "white")
        draw = ImageDraw.Draw(image)
        y = int(self.style["margin_top"])

        previous = None
        for block in blocks:
            if previous is not None:
                y += self._gap(previous, block.kind)
            y = self._draw_block(draw, image, block, y, body, width)
            previous = block.kind
            if y > max_height - 100:
                break

        # trim to content
        return image.crop(
            (0, 0, width, min(max_height, y + int(self.style["margin_bottom"])))
        )

    def _gap(self, previous: str, kind: str) -> int:
        """White space between two blocks, taken from whichever rule is stronger."""
        style = self.style
        if "space" in (previous, kind):
            return 0
        if previous == "heading":
            return int(style["heading_gap"])
        if "table" in (previous, kind):
            return int(style["table_gap"])
        if "quote" in (previous, kind):
            return int(style["quote_gap"])
        if previous == "list" and kind == "list":
            return int(style["list_item_gap"])
        if "list" in (previous, kind):
            return int(style["list_gap"])
        return int(style["block_gap"])

    def _rtl_font(self, size: int, bold: bool = False, italic: bool = False,
                  text: str = ""):
        """The face for a right to left run, chosen by what it has to draw.

        The font chosen for the document is asked first, so picking one that
        does carry Arabic changes the Arabic as well as the English. Most
        monospaced faces do not, and most of those that do stop short of the
        Quranic annotation marks, so the theme's own right to left face comes
        next and a list of faces that certainly have everything comes last.

        The choice is by run rather than by character, because a joining script
        sets as a piece: borrowing one glyph from elsewhere would break the
        shapes of the letters on either side of it.
        """
        candidates = [self.font_family, self.style["rtl_font"], *RTL_FALLBACK_FONTS]
        wanted = getattr(self, "_rtl_corpus", "") or text
        if not wanted:
            return self._fm.load_font(candidates[0] or self.font_family, size,
                                      bold=bold, italic=italic)
        return self._fm.font_for_text(candidates, size, wanted,
                                      bold=bold, italic=italic)

    def _segments(self, word: str, font):
        """Split a word where the font runs out of glyphs.

        A face that has no glyph for a character draws the empty box, and a
        page of boxes is worse than a page in two faces. Left to right text
        does not join, so a character can be borrowed from another font on its
        own without disturbing its neighbours. The common case is one segment,
        and coverage answers are cached, so this costs almost nothing when the
        font has everything.
        """
        if not word or self._fm.font_covers(font, word):
            return [(word, font)]

        size = getattr(font, "size", self.font_size)
        segments = []
        for char in word:
            chosen = font
            if not self._fm.font_has_glyph(font, char):
                chosen = self._fm.font_for_text(SYMBOL_FALLBACK_FONTS, size, char) or font
            if segments and segments[-1][1] is chosen:
                segments[-1] = (segments[-1][0] + char, chosen)
            else:
                segments.append((char, chosen))
        return segments

    def _text_width(self, word: str, font, size: int) -> float:
        total = float(self._embolden(font)) if getattr(font, "faux_bold", False) else 0.0
        for text, face in self._segments(word, font):
            try:
                total += face.getlength(text)
            except (AttributeError, OSError):
                total += size * len(text) * 0.6
        return total

    def _draw_rtl(self, draw, block: Block, y: int, left: int, width: int,
                  size: int, bold: bool = False, italic: bool = False) -> int:
        """Draw a right to left block: shaped, ordered, and set from the right."""
        text = "".join(span.text for span in block.spans)
        font = (self._rtl_font(size, bold, italic, text)
                or self._font(size, bold, italic))
        right = width - self.margin
        available = right - left

        # wrap by measuring whole strings, since a word's shape depends on its
        # neighbours and its position depends on the line
        words = text.split()
        lines, current = [], ""
        for word in words:
            candidate = f"{current} {word}".strip()
            try:
                too_wide = font.getlength(candidate) > available
            except (AttributeError, OSError):
                too_wide = len(candidate) * size * 0.6 > available
            if too_wide and current:
                lines.append(current)
                current = word
            else:
                current = candidate
        if current:
            lines.append(current)

        for line in lines or [""]:
            draw.text((right, y), line, font=font, fill="black",
                      direction="rtl", anchor="ra", language="ar")
            y += self._line_height(font)
        return y

    def _draw_block(self, draw, image, block: Block, y: int, left: int, width: int) -> int:
        right_margin = self.margin

        # right to left text takes its own path, whatever kind of block it is
        if block.spans and is_rtl("".join(span.text for span in block.spans)):
            if block.kind == "heading":
                scale = HEADING_SCALE.get(block.level, 1.0) * float(self.style["heading_scale"])
                y = self._draw_rtl(draw, block, y, left, width,
                                   max(10, int(self.font_size * scale)), bold=True)
                if block.level <= 2:
                    weight = int(self.style["rule_weight"]) if block.level == 1 else 1
                    above = int(self.style["rule_gap_above"])
                    y += above + self._draw_rule(draw, left, width - right_margin,
                                                 y + above, weight)
                return y
            if block.kind in ("paragraph", "quote", "list"):
                # No italic here even for a quote: Arabic does not use slanted
                # type, and the oblique faces that exist carry no Arabic at all,
                # so asking for one prints a row of empty boxes.
                edge = width - self.margin
                inset = 0
                top = y

                if block.kind == "list":
                    marker = f"{block.index}." if block.ordered else self._bullet(block.level)
                    font = self._font(self.font_size)
                    try:
                        marker_width = int(font.getlength(marker + " "))
                    except (AttributeError, OSError):
                        marker_width = self.font_size
                    # the marker leads the line, which on this side is the right
                    draw.text((edge - marker_width, y), marker, font=font, fill="black")
                    inset = marker_width + int(self.style["list_indent"])

                bar = int(self.style["quote_bar"]) if block.kind == "quote" else 0
                if bar:
                    inset = max(inset, bar + int(self.style["quote_pad"]))

                y = self._draw_rtl(draw, block, y, left, width - inset, self.font_size)

                if bar:
                    # the bar goes on the right, because that is where the text
                    # starts when the line runs the other way
                    draw.rectangle([edge - bar, top, edge, y], fill="black")
                return y

        if block.kind == "space":
            return y + int(self._line_height(self._font(self.font_size)) * 0.6)

        if block.kind == "rule":
            draw.rectangle([left, y, width - right_margin, y + 1], fill="black")
            return y + 2

        if block.kind == "code":
            font = self._font(max(12, int(self.font_size * 0.8)), mono=True)
            pitch = self._line_height(font)
            box_top = y
            inner = left + 6
            for line in block.lines:
                draw.text((inner, y + 3), line, font=font, fill="black")
                y += pitch
            # a left bar reads as "code" without needing a background fill,
            # which would waste an enormous amount of thermal ink
            draw.rectangle([left, box_top, left + 2, y + 2], fill="black")
            return y + 2

        if block.kind == "math":
            expression = block.lines[0] if block.lines else ""
            rendered = render_math(
                expression,
                font_size=self.font_size,
                max_width=width - left - right_margin,
            )
            if rendered is None:
                # unparseable or matplotlib missing - the source is still
                # more useful to a reader than nothing at all
                font = self._font(max(12, int(self.font_size * 0.85)), mono=True)
                draw.text((left, y), expression, font=font, fill="black")
                return y + self._line_height(font) + 6

            x = left + max(0, (width - left - right_margin - rendered.width) // 2)
            image.paste(rendered, (x, y))
            return y + rendered.height

        if block.kind == "image":
            return self._draw_image(image, block, y, left, width)

        if block.kind == "table":
            return self._draw_table(draw, block, y, left, width)

        if block.kind == "heading":
            return self._draw_heading(draw, block, y, left, width)

        if block.kind == "quote":
            bar = int(self.style["quote_bar"])
            inner = left + int(self.style["quote_pad"])
            top = y
            italic = bool(self.style["quote_italic"])
            lines = self._wrap_spans(block.spans, self.font_size,
                                     width - inner - right_margin, force_italic=italic)
            for line in lines:
                y = self._draw_line(draw, line, y, inner, self.font_size,
                                    force_italic=italic)
            if bar:
                draw.rectangle([left, top, left + bar, y], fill="black")
            return y

        if block.kind == "list":
            marker = f"{block.index}." if block.ordered else self._bullet(block.level)
            indent = left + int(self.style["list_indent"]) + block.level * 16
            font = self._font(self.font_size)

            if block.borders in ("todo", "done"):
                # drawn rather than written, so it does not depend on the font
                # carrying ballot glyphs
                box = int(self.font_size * 0.72)
                top = y + int(self.font_size * 0.22)
                draw.rectangle([indent, top, indent + box, top + box],
                               outline="black", width=2)
                if block.borders == "done":
                    draw.line([indent + 3, top + box // 2,
                               indent + box // 2, top + box - 4], fill="black", width=2)
                    draw.line([indent + box // 2, top + box - 4,
                               indent + box - 2, top + 3], fill="black", width=2)
                marker_width = box + int(self.font_size * 0.45)
                lines = self._wrap_spans(
                    block.spans, self.font_size, width - indent - marker_width - right_margin
                )
                for line in lines:
                    y = self._draw_line(draw, line, y, indent + marker_width, self.font_size)
                return y

            try:
                marker_width = int(font.getlength(marker + " "))
            except (AttributeError, OSError):
                marker_width = self.font_size
            draw.text((indent, y), marker, font=font, fill="black")
            lines = self._wrap_spans(
                block.spans, self.font_size, width - indent - marker_width - right_margin
            )
            for line in lines:
                y = self._draw_line(draw, line, y, indent + marker_width, self.font_size)
            return y

        lines = self._wrap_spans(block.spans, self.font_size, width - left - right_margin)
        for line in lines:
            y = self._draw_line(draw, line, y, left, self.font_size)
        return y

    # ---------------------------------------------------------------- style
    def _bullet(self, level: int) -> str:
        if level == 0:
            return str(self.style["bullet"]) or BULLETS[0]
        return BULLETS[min(level, 2)]

    def _line_width(self, line) -> int:
        return int(sum(self._text_width(word, font, self.font_size)
                       for _span, word, font in line))

    def _draw_rule(self, draw, x0: int, x1: int, y: int, weight: int) -> int:
        """Draw the rule the theme asked for and return the height it used."""
        kind = self.style["rule_style"]
        if kind == "none":
            return 0
        if kind == "dotted":
            self._dotted_rule(draw, x0, x1, y)
            return 1
        if kind == "double":
            draw.rectangle([x0, y, x1, y], fill="black")
            draw.rectangle([x0, y + 3, x1, y + 3], fill="black")
            return 4
        draw.rectangle([x0, y, x1, y + weight - 1], fill="black")
        return weight

    def _draw_heading(self, draw, block: Block, y: int, left: int, width: int) -> int:
        right = width - self.margin
        scale = HEADING_SCALE.get(block.level, 1.0) * float(self.style["heading_scale"])
        size = max(10, int(self.font_size * scale))

        spans = block.spans
        if self.style["heading_case"] == "upper":
            spans = [replace(s, text=s.text.upper()) for s in spans]

        banner = bool(self.style["heading_banner"]) and block.level == 1
        pad = 5 if banner else 0
        available = width - left - self.margin - 2 * pad
        # headings are drawn bold, so they are measured bold
        lines = self._wrap_spans(spans, size, available, force_bold=True)

        if banner:
            # a filled bar with the heading knocked out of it; the strongest
            # mark a one-bit page can make, and unmistakably one theme's voice
            height = sum(
                max((self._line_height(font) for _s, _w, font in line), default=size)
                for line in lines
            )
            draw.rectangle([left, y, right, y + height + 2 * pad], fill="black")
            text_y = y + pad
            for line in lines:
                x = left + pad
                if self.style["heading_align"] == "center":
                    x = left + max(pad, (right - left - self._line_width(line)) // 2)
                text_y = self._draw_line(draw, line, text_y, x, size,
                                         force_bold=True, fill="white")
            return y + height + 2 * pad + 8

        for line in lines:
            x = left
            if self.style["heading_align"] == "center":
                x = left + max(0, (right - left - self._line_width(line)) // 2)
            y = self._draw_line(draw, line, y, x, size, force_bold=True)

        if block.level <= 2:
            # a second level heading takes a hairline, so the two levels read
            # as a hierarchy rather than as two of the same thing
            weight = int(self.style["rule_weight"]) if block.level == 1 else 1
            above = int(self.style["rule_gap_above"])
            used = self._draw_rule(draw, left, right, y + above, weight)
            y += above + used
        return y

    def _draw_line(self, draw, line, y: int, x_start: int, size: int,
                   force_bold: bool = False, force_italic: bool = False,
                   fill: str = "black") -> int:
        x = x_start
        height = 0
        # a space the line happens to end on is not underlined or struck: the
        # rule would run on past the last letter into nothing
        last = len(line) - 1
        while last >= 0 and line[last][1].isspace():
            last -= 1
        for index, (span, word, font) in enumerate(line):
            if force_bold or force_italic:
                font = self._font(size, span.bold or force_bold,
                                  span.italic or force_italic, span.mono)
            if font is None:
                continue

            # a raised or lowered run is set smaller and shifted, which is all
            # a one bit page can do to say "superscript"
            offset = 0
            if span.raise_:
                base = font
                font = self._font(max(8, int(size * 0.7)), span.bold or force_bold,
                                  span.italic or force_italic, span.mono) or font
                offset = self._raise_offset(base, font, span.raise_, size)

            word_width = self._text_width(word, font, size)

            line_height = self._line_height(font)

            if span.highlight:
                # reverse video: the head is very good at solid black, and this
                # is the only "colour" a highlight can have on paper
                # the face's own height, not the line's: the gap under a line
                # belongs to the line spacing, and a box filling it looks
                # like a misprint
                draw.rectangle(
                    [x - 1, y, x + word_width + 1, y + min(line_height, sum(font.getmetrics())) - 1],
                    fill="black",
                )
                self._paint(draw, x, y + offset, word, font, "white", size)
            else:
                self._paint(draw, x, y + offset, word, font, fill, size)

            if index <= last:
                self._decorate(draw, span, x, y + offset, word_width, font,
                               "white" if span.highlight else fill)

            x += word_width
            height = max(height, self._line_height(font) if not span.raise_
                         else int(size * 1.2))
        return y + (height or int(size * 1.2))

    def _paint(self, draw, x: float, y: int, word: str, font, fill: str, size: int):
        """Draw a word, borrowing a face for any character this one lacks.

        A borrowed glyph takes on the synthetic weight or slant of the face it
        stands in for, so one symbol does not stand upright in a slanted word.
        """
        bold = getattr(font, "faux_bold", False)
        slant = getattr(font, "faux_slant", False)
        for text, face in self._segments(word, font):
            self._draw_text(draw, x, y, text, face, fill, bold, slant)
            try:
                x += face.getlength(text)
            except (AttributeError, OSError):
                x += size * len(text) * 0.6

    def _draw_text(self, draw, x: float, y: int, text: str, face, fill: str,
                   bold: bool = False, slant: bool = False) -> None:
        weight = self._embolden(face) if bold else 0
        if not slant:
            # synthetic bold is the old typewriter trick: strike it again a dot
            # to the right, which a thermal head renders as a heavier stroke
            for shift in range(weight + 1):
                draw.text((x + shift, y), text, font=face, fill=fill)
            return

        # synthetic italic: set the word upright on its own, shear it about the
        # baseline so the tops lean right and the descenders left, and stamp it
        ascent, descent = face.getmetrics()
        lean_left = int(self.SLANT * descent) + 2
        lean_right = int(self.SLANT * ascent) + 2
        mask = Image.new("L", (int(face.getlength(text)) + weight + lean_left + lean_right,
                               ascent + descent))
        pen = ImageDraw.Draw(mask)
        for shift in range(weight + 1):
            pen.text((lean_left + shift, 0), text, font=face, fill=255)
        mask = mask.transform(mask.size, Image.AFFINE,
                              (1, self.SLANT, -self.SLANT * ascent, 0, 1, 0),
                              resample=Image.BICUBIC)
        draw.bitmap((round(x) - lean_left, y), mask, fill=fill)

    @staticmethod
    def _raise_offset(base, small, direction: int, size: int) -> int:
        """How far down to set a raised or lowered run's top, from the line's top.

        Measured baseline to baseline: the smaller face has a shorter ascent, so
        its top already sits lower, and a fixed nudge would leave a subscript
        floating above the line it belongs under.
        """
        try:
            drop = base.getmetrics()[0] - small.getmetrics()[0]
        except (AttributeError, OSError):
            drop = int(size * 0.25)
        return drop + (int(size * 0.15) if direction < 0 else -int(size * 0.38))

    def _x_height(self, font) -> int:
        key = (getattr(font, "path", None), getattr(font, "size", 0))
        if key not in self._x_heights:
            try:
                self._x_heights[key] = max(1, -font.getbbox("x", anchor="ls")[1])
            except (AttributeError, OSError, ValueError):
                self._x_heights[key] = max(1, int(getattr(font, "size", 24) * 0.5))
        return self._x_heights[key]

    def _decorate(self, draw, span: Span, x: float, y: int, word_width: float,
                  font, fill: str) -> None:
        """Underline and strike through a word set with its top at y.

        Both are placed from the face's own metrics rather than from the line
        height, so they stay on the baseline and through the letters whatever
        the line spacing is, and they are thick enough to survive the head.
        """
        if not (span.underline or span.strike):
            return
        try:
            ascent, descent = font.getmetrics()
        except (AttributeError, OSError):
            ascent, descent = int(self.font_size * 0.8), int(self.font_size * 0.2)
        thick = max(1, round(getattr(font, "size", self.font_size) / 14))
        x0, x1 = int(x), int(x + word_width) - 1
        if x1 < x0:
            return
        if span.underline:
            top = y + ascent + max(1, descent // 3)
            draw.rectangle([x0, top, x1, top + thick - 1], fill=fill)
        if span.strike:
            top = y + ascent - self._x_height(font) // 2 - thick // 2
            draw.rectangle([x0, top, x1, top + thick - 1], fill=fill)

    def _draw_image(self, sheet, block: Block, y: int, left: int, width: int) -> int:
        """Place a picture, scaled to the paper and reduced to ink or nothing.

        A thermal head has one colour, so a photograph has to become a dither
        pattern before it means anything; anything that cannot be loaded falls
        back to its alt text rather than leaving a hole in the page.
        """
        source = block.lines[0] if block.lines else ""
        picture = self._load_image(source)
        if picture is None:
            font = self._font(self.font_size, italic=True)
            # The alt text is what the author wrote about the picture, and is
            # worth printing. A file name is not: it is an accident of where
            # the picture came from, and "b86d875052f404bb.png" on the paper
            # helps nobody, so a label that is only a file name is dropped.
            label = (block.spans[0].text if block.spans else "").strip()
            if not label or _looks_like_filename(label):
                label = "image"
            ImageDraw.Draw(sheet).text((left, y), f"[{label}]", font=font, fill="black")
            return y + self._line_height(font)

        available = width - left - self.margin
        if picture.width > available:
            picture = picture.resize(
                (available, max(1, round(picture.height * available / picture.width))),
                Image.LANCZOS,
            )

        # A picture has to become a pattern of dots to mean anything at 203 dpi,
        # and which pattern is a matter of taste and of subject: line art wants
        # a hard threshold, a photograph wants error diffusion, and a large flat
        # area wants Atkinson, which keeps less ink on the paper.
        # the title slot carries "mode t=<cutoff> s=<amount> f=<prefilter>",
        # any part of which may be missing and falls back to the page's setting
        parts = (block.borders or "").split()
        mode = (parts[0] if parts and "=" not in parts[0]
                else self.style["image_dither"] or "floyd-steinberg").lower()
        options = dict(part.split("=", 1) for part in parts if "=" in part)

        def number(key, fallback, cast):
            try:
                return cast(options[key])
            except (KeyError, TypeError, ValueError):
                return cast(fallback)

        sheet.paste(
            dither_image(
                picture, mode,
                threshold=number("t", self.style["image_threshold"], int),
                strength=number("s", self.style["image_strength"], float),
                prefilter=str(options.get("f", self.style["image_prefilter"])),
            ).convert("RGB"),
            (left, y),
        )
        return y + picture.height

    def _load_image(self, source: str):
        try:
            name = source.rsplit("/", 1)[-1]
            if self.image_root and (source.startswith("/images/") or "/" not in source):
                path = (self.image_root / name).resolve()
                if path.parent != Path(self.image_root).resolve() or not path.is_file():
                    return None
            else:
                path = Path(source).expanduser()
                if not path.is_file():
                    return None
            return Image.open(path).convert("RGB")
        except (OSError, ValueError):
            return None

    def _cell_pieces(self, cell: str, size: int, header: bool):
        """A cell's text as drawable pieces, one per word, with its own font.

        A cell is text like any other, so everything the body understands has
        to work here too: bold, italic, code, highlight, underline, strike and raised
        or lowered runs. The span travels with the piece so the drawing code
        can decorate it the same way it decorates a paragraph.
        """
        pieces = []
        for span in self._parse_inline(cell):
            piece_size = max(8, int(size * 0.7)) if span.raise_ else size
            font = self._font(piece_size, span.bold or header, span.italic,
                              mono=True if span.mono else True)
            for word in re.split(r"(\s+)", span.text):
                if not word:
                    continue
                piece_width = self._text_width(word, font, piece_size)
                pieces.append((word, font, piece_width, span))
        return pieces

    @staticmethod
    def _wrap_pieces(pieces, limit: float):
        """Break a cell's pieces into lines that fit the column.

        Wrapping rather than truncating: a table that quietly drops the end of
        a name is worse than one that is a line taller, and on 58 mm paper
        something always has to give.
        """
        lines, line, used = [], [], 0.0
        for word, font, piece_width, span in pieces:
            if word.isspace():
                if line:
                    line.append((word, font, piece_width, span))
                    used += piece_width
                continue
            if line and used + piece_width > limit:
                lines.append(line)
                line, used = [], 0.0
            if piece_width > limit and not line:
                # one word wider than the column: break it rather than spill
                for character in word:
                    try:
                        character_width = font.getlength(character)
                    except (AttributeError, OSError):
                        character_width = piece_width / max(1, len(word))
                    if line and used + character_width > limit:
                        lines.append(line)
                        line, used = [], 0.0
                    line.append((character, font, character_width, span))
                    used += character_width
                continue
            line.append((word, font, piece_width, span))
            used += piece_width
        if line:
            lines.append(line)
        return lines or [[]]

    def _draw_table(self, draw, block: Block, y: int, left: int, width: int) -> int:
        if not block.rows:
            return y

        columns = max(len(row) for row in block.rows)
        usable = width - left - self.margin
        right = width - self.margin

        size = max(10, int(self.font_size * float(self.style["table_scale"])))
        pad = int(self.style["table_cell_pad"])
        font = self._font(size, mono=True)
        pitch = self._line_height(font)

        # Columns are sized to what is in them, not to the page: a table on a
        # long strip should be as wide as its contents and no wider, and a table
        # on 58 mm paper should give its room to the columns that need it. Only
        # when the natural widths do not fit is anything taken away, and then
        # proportionally, from the widest first.
        cells = [
            [self._cell_pieces(row[column] if column < len(row) else "", size, index == 0)
             for column in range(columns)]
            for index, row in enumerate(block.rows)
        ]
        natural = [
            max((sum(piece[2] for piece in cells[row][column]) for row in range(len(cells))),
                default=0) + 2 * pad
            for column in range(columns)
        ]
        if block.shares and len(block.shares) == columns:
            # the document says how the width is divided, so it is divided that
            # way and the contents wrap into whatever room that leaves
            share_total = sum(block.shares)
            natural = [usable * share / share_total for share in block.shares]

        total = sum(natural) or 1
        if total > usable:
            widths = [max(size * 2.0, value * usable / total) for value in natural]
            # rounding can push it back over, so the last column absorbs it
            overflow = sum(widths) - usable
            if overflow > 0:
                widths[-1] = max(size * 2.0, widths[-1] - overflow)
        else:
            widths = natural

        # rules belong to the table, not to the page, so they stop where it does
        right = min(right, left + int(sum(widths)))

        # A grid is what a table is for, so it is what a table gets unless the
        # document says otherwise. "theme" is still there for anyone who wants
        # the lighter treatment a theme prescribes.
        borders = block.borders or "all"
        top = y

        for row_index, row_cells in enumerate(cells):
            wrapped = [
                self._wrap_pieces(cell, widths[column] - 2 * pad)
                for column, cell in enumerate(row_cells)
            ]
            height = max(len(lines) for lines in wrapped)

            x = left
            for column, lines in enumerate(wrapped):
                alignment = block.align[column] if column < len(block.align) else "left"
                for line_index, line in enumerate(lines):
                    used = sum(piece[2] for piece in line)
                    if alignment == "right":
                        cursor = x + widths[column] - pad - used
                    elif alignment == "center":
                        cursor = x + (widths[column] - used) / 2
                    else:
                        cursor = x + pad
                    line_top = y + pad + line_index * pitch
                    for piece_index, (text, piece_font, piece_width, span) in enumerate(line):
                        offset = 0
                        if span.raise_:
                            offset = self._raise_offset(
                                font, piece_font, span.raise_, size)

                        if span.highlight:
                            # reverse video, the only "colour" paper has
                            draw.rectangle(
                                [cursor - 1, line_top,
                                 cursor + piece_width + 1, line_top + pitch - 2],
                                fill="black",
                            )
                        ink = "white" if span.highlight else "black"
                        self._paint(draw, cursor, line_top + offset, text,
                                    piece_font, ink, size)
                        if not (text.isspace() and piece_index == len(line) - 1):
                            self._decorate(draw, span, cursor, line_top + offset,
                                           piece_width, piece_font, ink)

                        cursor += piece_width
                x += widths[column]

            y += pitch * height + 2 * pad

            if borders == "none":
                continue
            if row_index == 0:
                weight = max(1, int(self.style["table_header_rule"]))
                draw.rectangle([left, y, right, y + weight - 1], fill="black")
                y += weight
            elif row_index < len(block.rows) - 1 or borders == "all":
                kind = "solid" if borders == "all" else self.style["table_rule"]
                if kind == "dotted":
                    self._dotted_rule(draw, left, right, y)
                    y += 1
                elif kind == "solid":
                    draw.rectangle([left, y, right, y], fill="black")
                    y += 1

        if borders == "all":
            # the outer frame and the column rules, drawn once the height of
            # the whole table is known
            draw.rectangle([left, top, right, y], outline="black", width=1)
            x = left
            for column in range(columns - 1):
                x += widths[column]
                draw.rectangle([x, top, x, y], fill="black")

        return y

    @staticmethod
    def _dotted_rule(draw, x0: int, x1: int, y: int, dash: int = 3, gap: int = 4) -> None:
        x = x0
        while x < x1:
            draw.rectangle([x, y, min(x + dash, x1), y], fill="black")
            x += dash + gap
