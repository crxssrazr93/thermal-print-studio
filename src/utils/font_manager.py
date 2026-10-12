"""Font management utilities for Linux systems.

This module handles font discovery, loading, and Unicode character support.
It scans system font directories, caches loaded fonts for performance, and
provides fallback mechanisms for Unicode characters not present in the
primary font.

Font loading is expensive due to filesystem access and font parsing. This module
uses multiple cache layers: _font_cache for loaded ImageFont objects keyed by
(family, size, bold, italic), _fallback_font_cache for Unicode fallback fonts,
and _glyph_cache for character existence checks. The global singleton ensures
font scanning happens only once per process.
"""

import os
import glob
import logging
from pathlib import Path
from typing import List, Optional, Dict, Tuple
from dataclasses import dataclass

from PIL import ImageFont

# project fonts directory (relative to project root)
PROJECT_FONTS_DIR = Path(__file__).parent.parent.parent / "fonts"

from ..config.defaults import (
    LINUX_FONT_PATHS,
    PREFERRED_FONTS,
    FALLBACK_FONTS,
    UNICODE_FALLBACK_FONTS,
    DEFAULT_FONT_SIZE,
    DEFAULT_FONT_FAMILY,
)
from ..core.exceptions import FontNotFoundError

logger = logging.getLogger(__name__)

# A codepoint in a private use plane that nothing maps, used to render the
# empty box a font draws when it is asked for something it does not have.
NOTDEF_PROBE = chr(0x0FFFFD)


# additional font paths for various systems
EXTRA_FONT_PATHS = [
    # linux truetype and opentype
    "/usr/share/fonts/truetype",
    "/usr/share/fonts/opentype",
    "/usr/share/fonts/TTF",
    "/usr/share/fonts/OTF",
    # linux specific font packages
    "/usr/share/fonts/google-droid",
    "/usr/share/fonts/droid",
    "/usr/share/fonts/noto",
    "/usr/share/fonts/liberation",
    "/usr/share/fonts/dejavu",
    "/usr/share/fonts/gnu-free",
    "/usr/share/fonts/freefont",
    # microsoft core fonts (often installed on linux)
    "/usr/share/fonts/truetype/msttcorefonts",
    "/usr/share/fonts/corefonts",
]


@dataclass
class FontInfo:
    """Information about a discovered font file."""
    name: str
    path: str
    family: str
    style: str


class FontManager:
    """Manages system fonts and Unicode fallback support.

    Scans system directories for fonts, provides font loading with style
    matching, and handles Unicode character rendering with automatic
    fallback to fonts that support missing characters.
    """
    def __init__(self):
        self._fonts: Dict[str, FontInfo] = {}
        self._font_families: Dict[str, List[FontInfo]] = {}
        self._fallback_fonts: List[ImageFont.FreeTypeFont] = []
        self._fallback_font_cache: Dict[int, Dict[str, ImageFont.FreeTypeFont]] = {}
        self._glyph_cache: Dict[str, Dict[str, bool]] = {}
        # one unshaped copy of each font, and the empty box it draws, so a
        # coverage question costs a dictionary lookup after the first time
        self._probe_cache: Dict[str, Optional[ImageFont.FreeTypeFont]] = {}
        self._notdef_cache: Dict[str, Tuple[Tuple[int, int], bytes]] = {}
        # cache loaded fonts to avoid repeated disk access
        self._font_cache: Dict[Tuple[str, int, bool, bool], ImageFont.FreeTypeFont] = {}
        self._dir_stamp_at_scan: Tuple[Tuple[str, float], ...] = ()
        self._scan_fonts()

    def _font_dirs(self) -> List[str]:
        paths = []
        if PROJECT_FONTS_DIR.is_dir():
            paths.append(str(PROJECT_FONTS_DIR))
        paths.extend(LINUX_FONT_PATHS)
        paths.extend(EXTRA_FONT_PATHS)
        return paths

    def _dir_stamp(self) -> Tuple[Tuple[str, float], ...]:
        """When each font directory last changed, for noticing an install.

        A font installed while the app is running is invisible until something
        looks again, and nobody expects to restart a print server because they
        added a typeface. Stat is cheap; the scan behind it is not, so it only
        runs when one of these has moved.
        """
        stamps = []
        for directory in self._font_dirs():
            # Fonts rarely land in the top of a font directory. A package drops
            # them in a folder of their own, and a font manager makes one per
            # family, so stat-ing only the top misses every install that
            # matters: the directory above an untouched subfolder does not
            # change. The walk is capped because a font directory is shallow
            # and a surprise symlink into the home directory should not turn a
            # list of fonts into a filesystem crawl.
            for path in self._walk_dirs(directory):
                try:
                    stamps.append((path, os.path.getmtime(path)))
                except OSError:
                    continue
        return tuple(sorted(stamps))

    @staticmethod
    def _walk_dirs(top: str, limit: int = 400) -> List[str]:
        """The directory and the directories under it, up to a sane number."""
        found = [top]
        try:
            for root, dirs, _ in os.walk(top, followlinks=False):
                for name in dirs:
                    found.append(os.path.join(root, name))
                    if len(found) >= limit:
                        return found
        except OSError:
            pass
        return found

    def refresh(self) -> int:
        """Scan again whatever the stamps say, and return how many families.

        The stamp is an optimisation, and an optimisation that is wrong once in
        a while needs a way to be overruled: a font installed by a method that
        leaves every directory mtime alone is still a font the user can see in
        every other application. This is what the Rescan button asks for.
        """
        self._clear_caches()
        self._scan_fonts()
        self._dir_stamp_at_scan = self._dir_stamp()
        return len(self.get_available_families())

    def _clear_caches(self) -> None:
        self._fonts.clear()
        self._font_families.clear()
        self._font_cache.clear()
        self._fallback_font_cache.clear()
        self._glyph_cache.clear()
        self._probe_cache.clear()
        self._notdef_cache.clear()

    def refresh_if_changed(self) -> bool:
        """Rescan if a font directory has changed since the last look."""
        stamp = self._dir_stamp()
        if stamp == self._dir_stamp_at_scan:
            return False
        self._fonts.clear()
        self._font_families.clear()
        self._font_cache.clear()
        self._fallback_font_cache.clear()
        self._glyph_cache.clear()
        self._probe_cache.clear()
        self._notdef_cache.clear()
        self._scan_fonts()
        logger.info("Font directories changed; rescanned")
        return True

    def _scan_fonts(self) -> None:
        font_extensions = ['*.ttf', '*.otf', '*.TTF', '*.OTF', '*.ttc', '*.TTC']

        for font_dir in self._font_dirs():
            if not os.path.isdir(font_dir):
                continue

            for ext in font_extensions:
                pattern = os.path.join(font_dir, '**', ext)
                for font_path in glob.glob(pattern, recursive=True):
                    self._register_font(font_path)

        self._dir_stamp_at_scan = self._dir_stamp()

    def _register_font(self, path: str) -> None:
        try:
            filename = os.path.basename(path)
            name_without_ext = os.path.splitext(filename)[0]
            family, style = self._parse_font_name(name_without_ext)

            font_info = FontInfo(
                name=name_without_ext,
                path=path,
                family=family,
                style=style
            )

            self._fonts[name_without_ext.lower()] = font_info

            family_lower = family.lower()
            if family_lower not in self._font_families:
                self._font_families[family_lower] = []
            self._font_families[family_lower].append(font_info)

        except (OSError, ValueError) as e:
            logger.debug(f"could not register font {path}: {e}")

    def _parse_font_name(self, name: str) -> Tuple[str, str]:
        style = "Regular"
        family = name

        style_markers = [
            ("-BoldItalic", "BoldItalic"),
            ("-BoldOblique", "BoldItalic"),
            ("-Bold", "Bold"),
            ("-Italic", "Italic"),
            ("-Oblique", "Italic"),
            ("-Regular", "Regular"),
            ("BoldItalic", "BoldItalic"),
            ("BoldOblique", "BoldItalic"),
            ("Bold", "Bold"),
            ("Italic", "Italic"),
            ("Oblique", "Italic"),
            ("Regular", "Regular"),
        ]

        for marker, style_name in style_markers:
            if name.endswith(marker):
                family = name[:-len(marker)].rstrip('-_ ')
                style = style_name
                break

        family = family.replace('-', ' ').replace('_', ' ')
        return family, style

    def get_available_families(self) -> List[str]:
        """Every family, in the order a person reads a list of names.

        Plain sorted() is ASCII order, which puts every capital before every
        lower case letter: "Verdana" lands hundreds of entries above "arial",
        and the list stops being alphabetical halfway down. Case is a property
        of how a foundry wrote the name, not of where the name belongs.
        """
        families = set()
        for family_list in self._font_families.values():
            for font_info in family_list:
                families.add(font_info.family)
        return sorted(families, key=lambda name: (name.casefold(), name))

    def get_family_styles(self, family: str) -> List[str]:
        family_lower = family.lower()
        if family_lower not in self._font_families:
            return []

        styles = set()
        for font_info in self._font_families[family_lower]:
            styles.add(font_info.style)
        return sorted(styles)

    def get_font_path(
        self,
        family: str,
        style: str = "Regular",
        fallback: bool = True
    ) -> Optional[str]:
        family_lower = family.lower()

        if family_lower in self._font_families:
            for font_info in self._font_families[family_lower]:
                if font_info.style == style:
                    return font_info.path

            if self._font_families[family_lower]:
                return self._font_families[family_lower][0].path

        if fallback:
            for preferred in PREFERRED_FONTS:
                preferred_lower = preferred.lower()
                if preferred_lower in self._font_families:
                    for font_info in self._font_families[preferred_lower]:
                        if font_info.style == style:
                            return font_info.path
                    if self._font_families[preferred_lower]:
                        return self._font_families[preferred_lower][0].path

        return None

    def load_font(
        self,
        family: str = DEFAULT_FONT_FAMILY,
        size: int = DEFAULT_FONT_SIZE,
        bold: bool = False,
        italic: bool = False
    ) -> ImageFont.FreeTypeFont:
        """Load a font with specified parameters.

        Uses cache to avoid repeated disk access. Tries to match requested
        style, falling back to available styles if exact match not found.
        """
        # check cache first
        cache_key = (family.lower(), size, bold, italic)
        if cache_key in self._font_cache:
            return self._font_cache[cache_key]

        if bold and italic:
            styles_to_try = ["BoldItalic", "BoldOblique", "Bold", "Italic", "Regular"]
        elif bold:
            styles_to_try = ["Bold", "Medium", "SemiBold", "Regular"]
        elif italic:
            styles_to_try = ["Italic", "Oblique", "LightItalic", "Regular"]
        else:
            styles_to_try = ["Regular", "Book", "Normal", "Medium"]

        font_path = None
        for style in styles_to_try:
            font_path = self.get_font_path(family, style, fallback=False)
            if font_path:
                break

        if font_path is None:
            font_path = self.get_font_path(family, styles_to_try[0], fallback=True)

        if font_path is None:
            # try ultimate fallback fonts
            for fallback in FALLBACK_FONTS:
                font_path = self.get_font_path(fallback, "Regular", fallback=False)
                if font_path:
                    break

        if font_path is None:
            # last resort use pillow default
            try:
                font = ImageFont.load_default()
                self._font_cache[cache_key] = font
                return font
            except (OSError, ImportError) as e:
                raise FontNotFoundError(f"cannot find font: {family}") from e

        try:
            font = ImageFont.truetype(font_path, size)
            self._font_cache[cache_key] = font
            return font
        except (OSError, IOError) as e:
            # if specific font fails try pillow default
            try:
                font = ImageFont.load_default()
                self._font_cache[cache_key] = font
                return font
            except (OSError, ImportError):
                raise FontNotFoundError(f"cannot load font {font_path}: {e}")

    def find_font_file(self, name: str) -> Optional[str]:
        name_lower = name.lower()

        if name_lower in self._fonts:
            return self._fonts[name_lower].path

        for font_name, font_info in self._fonts.items():
            if name_lower in font_name:
                return font_info.path

        return None

    def _probe_font(self, path: str) -> Optional[ImageFont.FreeTypeFont]:
        """A copy of a font laid out without shaping, for asking what it has.

        Shaping is what makes a font look right and what makes it lie about
        coverage: with it on, a lone combining mark comes back as a mark on a
        dotted circle, which is two glyphs and no longer comparable to
        anything. Turned off, one character is one glyph, so a missing one
        looks exactly like every other missing one.
        """
        if path in self._probe_cache:
            return self._probe_cache[path]
        probe = None
        try:
            probe = ImageFont.truetype(path, 24, layout_engine=ImageFont.Layout.BASIC)
        except (OSError, IOError, AttributeError, ValueError):
            probe = None
        self._probe_cache[path] = probe
        return probe

    def font_has_glyph(self, font: ImageFont.FreeTypeFont, char: str) -> bool:
        """True if the font can actually draw this character.

        A font asked for a character it does not have draws .notdef, the empty
        box, rather than nothing: measuring the result only says the box has a
        size. So the box itself is rendered once, from a codepoint no font will
        ever map, and anything that comes back identical to it is missing.
        """
        if not char or char.isspace():
            return True

        font_path = getattr(font, 'path', None)
        cache_key = font_path or str(id(font))
        if cache_key not in self._glyph_cache:
            self._glyph_cache[cache_key] = {}
        cached = self._glyph_cache[cache_key].get(char)
        if cached is not None:
            return cached

        has_glyph = True
        try:
            probe = self._probe_font(font_path) if font_path else None
            if probe is None:
                # nothing to compare against; an empty mask is still an answer
                mask = font.getmask(char)
                has_glyph = mask.size[0] > 0 and mask.size[1] > 0
            else:
                notdef = self._notdef_cache.get(font_path)
                if notdef is None:
                    reference = probe.getmask(NOTDEF_PROBE)
                    notdef = (reference.size, bytes(reference))
                    self._notdef_cache[font_path] = notdef
                mask = probe.getmask(char)
                if mask.size[0] == 0 or mask.size[1] == 0:
                    has_glyph = False
                else:
                    has_glyph = not (mask.size == notdef[0] and bytes(mask) == notdef[1])
        except (OSError, AttributeError, ValueError) as error:
            logger.debug("error checking glyph for %r: %s", char, error)
            has_glyph = False

        self._glyph_cache[cache_key][char] = has_glyph
        return has_glyph

    def font_covers(self, font: ImageFont.FreeTypeFont, text: str) -> bool:
        """True if every character in the text has a glyph in this font."""
        return all(self.font_has_glyph(font, char) for char in set(text))

    def font_for_text(self, families, size: int, text: str,
                      bold: bool = False, italic: bool = False):
        """The first of these families that can draw all of the text.

        Falling back a character at a time is wrong for a script that joins:
        the shape of a letter depends on its neighbours, so a run has to be set
        in one face. Whichever covers the most is used when none covers it all,
        which at least keeps the boxes down to the rarest characters.
        """
        best, best_score = None, -1
        for family in families:
            if not family:
                continue
            try:
                font = self.load_font(family, size, bold=bold, italic=italic)
            except FontNotFoundError:
                continue
            if font is None:
                continue
            if self.font_covers(font, text):
                return font
            score = sum(1 for char in set(text) if self.font_has_glyph(font, char))
            if score > best_score:
                best, best_score = font, score
        return best

    def get_unicode_fallback_fonts(self, size: int) -> List[ImageFont.FreeTypeFont]:
        if size in self._fallback_font_cache:
            return list(self._fallback_font_cache[size].values())

        self._fallback_font_cache[size] = {}
        fonts = []

        for family in UNICODE_FALLBACK_FONTS:
            font_path = self.get_font_path(family, "Regular", fallback=False)
            if font_path:
                try:
                    font = ImageFont.truetype(font_path, size)
                    fonts.append(font)
                    self._fallback_font_cache[size][family] = font
                except (OSError, IOError) as e:
                    logger.debug(f"could not load fallback font {family}: {e}")

        return fonts

    def find_font_for_char(
        self,
        char: str,
        primary_font: ImageFont.FreeTypeFont,
        size: int
    ) -> ImageFont.FreeTypeFont:
        if self.font_has_glyph(primary_font, char):
            return primary_font

        # search fallback fonts
        fallbacks = self.get_unicode_fallback_fonts(size)
        for font in fallbacks:
            if self.font_has_glyph(font, char):
                return font

        # no fallback found so return primary (will show placeholder)
        return primary_font

    def get_char_font_map(
        self,
        text: str,
        primary_font: ImageFont.FreeTypeFont,
        size: int
    ) -> Dict[str, ImageFont.FreeTypeFont]:
        """Build a map of character to best font for rendering.

        Optimizes by caching results and lazy-loading fallback fonts.
        """
        char_fonts = {}
        fallbacks = None

        for char in text:
            if char in char_fonts:
                continue

            if char == ' ' or self.font_has_glyph(primary_font, char):
                char_fonts[char] = primary_font
            else:
                # lazy load fallbacks only when needed
                if fallbacks is None:
                    fallbacks = self.get_unicode_fallback_fonts(size)

                found = False
                for font in fallbacks:
                    if self.font_has_glyph(font, char):
                        char_fonts[char] = font
                        found = True
                        break

                if not found:
                    char_fonts[char] = primary_font

        return char_fonts


_font_manager: Optional[FontManager] = None


def get_font_manager() -> FontManager:
    global _font_manager
    if _font_manager is None:
        _font_manager = FontManager()
    return _font_manager
