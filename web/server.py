# local web server for the browser front end
#
# Deliberately stdlib-only. This is a personal tool that runs on the same
# machine as the printer, so pulling in a web framework would add install
# friction for no benefit at this size.
#
# The browser cannot open an RFCOMM socket or write to /dev/usb/lp0, so
# everything that touches hardware stays in Python and the page talks to it
# over JSON. Rendering also stays here, which means the preview the browser
# shows is the exact bitmap that gets sent to the printer rather than a CSS
# approximation of it.

import base64
import binascii
import datetime
import hashlib
import io
import json
import logging
import mimetypes
import os
import re
import sys
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from src.config.defaults import (                # noqa: E402
    MAX_TEAR_GAP_MM,
    TEAR_CALIBRATION_LINES,
)
from src.config.printer_profile import (          # noqa: E402
    FLOW_DEFAULTS,
    delete_user_profile as delete_user_printer_profile,
    get_dpi,
    get_printer_width,
    get_printer_width_mm,
    get_profile_labels,
    get_tear_gap_mm,
    load_profiles as load_printer_profiles,
    save_user_profile as save_user_printer_profile,
    mm_to_dots,
    set_tear_gap_mm,
)
from src.config.settings import SettingsFactory   # noqa: E402
from src.core import device_profiles as profiles  # noqa: E402
from src.core.device_discovery import (           # noqa: E402
    list_bluetooth_devices,
    list_cups_queues,
    list_usb_devices,
)
from src.core.printer import PrinterConnection    # noqa: E402
from src.core.protocol import PrinterProtocol     # noqa: E402
from src.core.graphics_commands import COMMANDS as GRAPHICS_COMMANDS  # noqa: E402
from src.core.drivers import DRIVER_LABELS, get_driver          # noqa: E402
import numpy as np                                 # noqa: E402
from PIL import Image                              # noqa: E402

from src.processing.image_dither import (                     # noqa: E402
    DITHER_LABELS,
    DITHER_MODES,
    PREFILTER_LABELS,
    PREFILTERS,
)
from src.processing.calendar_renderer import CalendarRenderer   # noqa: E402
from src.processing.image_processor import ImageProcessor      # noqa: E402
from src.processing.label_renderer import (                    # noqa: E402
    LabelRenderer,
    TextAreaConfig,
)
from src.processing.escpos_emulator import emulate             # noqa: E402
from src.processing.symbols import SYMBOL_GROUPS               # noqa: E402
from src.processing.markdown_renderer import MarkdownRenderer  # noqa: E402
from src.utils.font_manager import get_font_manager            # noqa: E402

logger = logging.getLogger("thermal.web")

STATIC_DIR = Path(__file__).resolve().parent / "static"

# user data lives outside the repo so presets survive a git checkout
DATA_DIR = Path(
    os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")
) / "thermal-printer"
PRESETS_FILE = DATA_DIR / "presets.json"
TODOS_FILE = DATA_DIR / "todos.json"

# A theme is a CSS file plus a manifest entry. Built-ins ship with the app;
# anything the user drops in the data directory is merged on top, so a theme
# can be added, or a built-in replaced, without touching the source.
THEMES_DIR = STATIC_DIR / "themes"
USER_THEMES_DIR = DATA_DIR / "themes"

# Images live beside the presets rather than in the document: markdown carries
# a reference, and the renderer loads the file when it prints.
IMAGES_DIR = DATA_DIR / "images"

# label backgrounds ship with the app; a user's own live in the data directory,
# so a background that was uploaded survives a checkout the way presets do.
TEMPLATES_DIR = ROOT / "gallery" / "templates"
USER_TEMPLATES_DIR = DATA_DIR / "labels"

# a saved label is a background plus the blocks placed on it, under a name
LABELS_FILE = DATA_DIR / "labels.json"

# whether the server listens to the network or only to this machine. Kept here
# rather than in the unit file so it can be answered in the app, and read at
# startup as well as when it changes.
NETWORK_FILE = DATA_DIR / "network.json"

DEFAULT_FONT = "DejaVuSansMono"   # family names carry no spaces; a miss falls back silently
DEFAULT_SIZE = 24
DEFAULT_LINE_SPACING = 1.1
MAX_IMAGE_BYTES = 8 * 1024 * 1024


# -----------------------------------------------------------------------------
# json-backed storage
# -----------------------------------------------------------------------------
_store_lock = threading.Lock()


def _slug(text: str) -> str:
    """A file name from something a person typed: letters, digits, dashes."""
    return re.sub(r"-+", "-", re.sub(r"[^A-Za-z0-9]+", "-", str(text))).strip("-").lower()[:48]


def _read_json(path: Path, fallback):
    try:
        with path.open() as handle:
            return json.load(handle)
    except (FileNotFoundError, json.JSONDecodeError):
        return fallback
    except OSError as error:
        logger.warning("Could not read %s: %s", path, error)
        return fallback


def _write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    # write via a temp file so a crash mid-write cannot truncate the store
    temp = path.with_suffix(path.suffix + ".tmp")
    with temp.open("w") as handle:
        json.dump(payload, handle, indent=2)
    temp.replace(path)


def load_presets():
    return _read_json(PRESETS_FILE, [])


# -----------------------------------------------------------------------------
# what the server listens on
# -----------------------------------------------------------------------------
LOCAL_HOST = "127.0.0.1"
OPEN_HOST = "0.0.0.0"

# an environment override is the operator speaking, and outranks the checkbox
HOST_OVERRIDE = os.environ.get("THERMAL_WEB_HOST") or ""
PORT = int(os.environ.get("THERMAL_WEB_PORT", "8760"))

# set when a rebind has been asked for; main() loops rather than exits
_rebind_wanted = False
SERVER = None


def network_exposed() -> bool:
    stored = _read_json(NETWORK_FILE, {})
    return bool(stored.get("exposed")) if isinstance(stored, dict) else False


def set_network_exposed(exposed: bool) -> None:
    stored = _read_json(NETWORK_FILE, {})
    if not isinstance(stored, dict):
        stored = {}
    stored["exposed"] = bool(exposed)
    _write_json(NETWORK_FILE, stored)


def listen_host() -> str:
    if HOST_OVERRIDE:
        return HOST_OVERRIDE
    return OPEN_HOST if network_exposed() else LOCAL_HOST


def local_addresses():
    """Addresses this machine can be reached at, for the app to show.

    Asked of the routing table rather than of DNS: a UDP socket to an address
    nobody has to answer reveals which interface would carry the traffic.
    """
    import socket
    found = []
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("192.0.2.1", 9))       # reserved, never routed
        found.append(probe.getsockname()[0])
    except OSError:
        pass
    finally:
        probe.close()
    return found


# -----------------------------------------------------------------------------
# the raw port
# -----------------------------------------------------------------------------
# Port 9100 is what every print system means by "a network printer": send it
# ESC/POS and it prints. Turning it on here puts this app in front of a printer
# that has no network of its own, so CUPS on another machine, a point of sale
# till or anything that speaks the protocol can use it. The bytes are passed
# through untouched, under the same lock a job from the app takes, so the two
# cannot interleave on one socket.
RAW_PORT = int(os.environ.get("THERMAL_RAW_PORT", "9100"))
RAW_MAX_BYTES = 16 * 1024 * 1024      # one job; anything larger is a runaway
RAW_IDLE_SECONDS = 5.0                # a sender that stops mid-job is done

_raw_server = None
_raw_lock = threading.Lock()


def raw_port_enabled() -> bool:
    stored = _read_json(NETWORK_FILE, {})
    return bool(stored.get("rawPort")) if isinstance(stored, dict) else False


def set_raw_port_enabled(enabled: bool) -> None:
    stored = _read_json(NETWORK_FILE, {})
    if not isinstance(stored, dict):
        stored = {}
    stored["rawPort"] = bool(enabled)
    _write_json(NETWORK_FILE, stored)


def _raw_serve(sock) -> None:
    while True:
        try:
            client, address = sock.accept()
        except OSError:
            return                                   # the listener was closed
        threading.Thread(target=_raw_job, args=(client, address),
                         daemon=True).start()


def _raw_job(client, address) -> None:
    """Read one job off the socket and put it on the printer, unaltered."""
    data = bytearray()
    try:
        client.settimeout(RAW_IDLE_SECONDS)
        while len(data) < RAW_MAX_BYTES:
            chunk = client.recv(65536)
            if not chunk:
                break
            data += chunk
    except OSError:
        pass
    finally:
        try:
            client.close()
        except OSError:
            pass

    if not data or SESSION is None:
        return
    if not SESSION.printer.is_connected:
        logger.warning("Raw job of %d bytes from %s dropped: no printer",
                       len(data), address[0])
        return

    with SESSION.lock:
        try:
            SESSION.printer.send_raw(bytes(data))
            logger.info("Raw job of %d bytes from %s printed", len(data), address[0])
        except Exception as error:
            logger.warning("Raw job from %s failed: %s", address[0], error)
            SESSION.last_error = str(error)


def start_raw_port() -> Optional[int]:
    """Open the raw port if it is wanted and not already open."""
    global _raw_server
    import socket as socket_module

    with _raw_lock:
        if _raw_server is not None or not raw_port_enabled():
            return RAW_PORT if _raw_server is not None else None
        sock = socket_module.socket(socket_module.AF_INET, socket_module.SOCK_STREAM)
        sock.setsockopt(socket_module.SOL_SOCKET, socket_module.SO_REUSEADDR, 1)
        try:
            # follows the web listener: local only unless the app is exposed,
            # since a raw port is the same decision with fewer questions asked
            sock.bind((listen_host(), RAW_PORT))
            sock.listen(4)
        except OSError as error:
            sock.close()
            logger.warning("Could not open the raw port: %s", error)
            return None
        _raw_server = sock
        threading.Thread(target=_raw_serve, args=(sock,), daemon=True).start()
        logger.info("Raw port listening on %s:%d", listen_host(), RAW_PORT)
        return RAW_PORT


def stop_raw_port() -> None:
    global _raw_server
    with _raw_lock:
        if _raw_server is None:
            return
        try:
            _raw_server.close()
        except OSError:
            pass
        _raw_server = None


def request_rebind() -> None:
    """Bring the listener back up on the other address.

    The socket is bound once, at startup, so changing what it listens on means
    a new socket. main() waits for the old one to stop and starts the next,
    which is a few milliseconds of no server rather than a restart of the
    process: the printer connection, the presets and the lock all survive it.
    """
    global _rebind_wanted
    if SERVER is None:
        return
    # the raw port follows the web listener, so it moves with it
    stop_raw_port()
    _rebind_wanted = True
    threading.Thread(target=SERVER.shutdown, daemon=True).start()


def load_todos():
    return _read_json(TODOS_FILE, [])


def load_themes():
    """Built-in themes, then user themes; a repeated id replaces the built-in."""
    merged = {}
    for directory, prefix, source in (
        (THEMES_DIR, "themes/", "builtin"),
        (USER_THEMES_DIR, "/themes/user/", "user"),
    ):
        manifest = _read_json(directory / "themes.json", {})
        for entry in manifest.get("themes", []):
            theme_id = str(entry.get("id") or "").strip()
            stylesheet = entry.get("stylesheet") or ""
            if not theme_id or not stylesheet:
                continue
            merged[theme_id] = {
                "id": theme_id,
                "name": entry.get("name") or f"Theme {theme_id}",
                "href": prefix + stylesheet,
                "swatch": entry.get("swatch") or [],
                "print": entry.get("print") or {},
                "source": source,
            }
    return list(merged.values())


# -----------------------------------------------------------------------------
# template tokens
# -----------------------------------------------------------------------------
# Expanded at render time rather than when a preset is saved, so a stored
# preset stays a template and prints today's date every time it is used.
_TOKENS = {
    "date": "%d %b %Y",
    "time": "%H:%M",
    "datetime": "%d %b %Y, %H:%M",
    "weekday": "%A",
}
_TOKEN_RE = re.compile(r"\{\{\s*(" + "|".join(_TOKENS) + r")\s*\}\}", re.IGNORECASE)


def expand_tokens(text: str) -> str:
    if not text or "{{" not in text:
        return text
    now = time.localtime()
    return _TOKEN_RE.sub(
        lambda m: time.strftime(_TOKENS[m.group(1).lower()], now), text
    )


# -----------------------------------------------------------------------------
# printer session
# -----------------------------------------------------------------------------
class Session:
    """Owns the one printer connection and serialises access to it.

    A thermal printer is a single serial stream: two overlapping jobs
    interleave their bytes and produce garbage, so every write goes through
    one lock regardless of how many browser tabs are open.
    """

    def __init__(self):
        self.settings = SettingsFactory.create()
        self.printer = PrinterConnection()
        self.lock = threading.Lock()
        self.last_error: Optional[str] = None

    # --- rendering -----------------------------------------------------------
    def _pipeline(self, text: str, options: Dict[str, Any]):
        """Render markdown and return (rendered image, configured processor)."""
        text = expand_tokens(text)
        head_width = get_printer_width()

        # Along the roll rather than across it: the page is composed on a strip
        # as long as the user asks for and only as deep as the head is wide,
        # then turned a quarter turn so the lines run down the paper. Lines get
        # long and few, which is the trade: a banner, a label, a ticket.
        Session.trimmed = False
        landscape = (options.get("orientation") or "portrait") == "landscape"
        length = max(head_width, int(options.get("page_length") or 1200))
        compose_width = length if landscape else head_width

        renderer = MarkdownRenderer(
            width=compose_width,
            font_family=options.get("font") or DEFAULT_FONT,
            font_size=int(options.get("size") or DEFAULT_SIZE),
            line_spacing=float(options.get("line_spacing") or DEFAULT_LINE_SPACING),
            # how the page is set: the theme's own typographic voice, so its
            # printed output is as recognisable as its chrome
            style=options.get("style") or None,
            image_root=IMAGES_DIR,
        )
        image = renderer.render(text or " ")

        if landscape:
            image = self._trim_tail(self._turn(image, head_width))
        elif options.get("trim_blank", True):
            # Down the page the renderer stops where the words do, but a
            # trailing rule, a picture with white in it or a blank last line all
            # leave paper that will only ever be fed and torn off. Trimming it
            # here rather than at print time keeps the preview honest: what is
            # on screen is the paper that comes out.
            image = self._trim_tail(image)
        processor = ImageProcessor(
            brightness=1.0,
            contrast=float(options.get("darkness") or 1.0),
            auto_resize=False,
            printer_width=get_printer_width(),
        )
        return image, processor

    # set when the last composed strip was deeper than the head, so the UI can
    # say so rather than let the user find out on paper
    trimmed = False

    @staticmethod
    def _trim_tail(image):
        """Cut the blank end off a strip printed along the roll.

        The strip length is how much room the words have, not how much paper
        the job should use: a two word banner on a 150 mm strip would otherwise
        feed 150 mm of paper and most of it blank. Done after the turn, where a
        row is a row of paper, so the end can simply be given the same room the
        start has rather than being reasoned about through a rotation.
        """
        pixels = np.asarray(image.convert("L")) < 200

        # A rule under a heading runs the length of the strip, which after the
        # turn is a line down the paper: every row has ink in it and nothing
        # would ever be trimmed. Columns that are inked nearly all the way down
        # are therefore left out of the measurement, and cut back with the rest.
        runs = pixels.mean(axis=0) < 0.9
        body = pixels[:, runs] if runs.any() else pixels
        rows = np.where(body.any(axis=1))[0]
        if not len(rows):
            # nothing on it at all: a short blank strip beats a long one
            return image.crop((0, 0, image.width, min(image.height, 96)))

        lead = int(rows[0])
        end = min(image.height, int(rows[-1]) + lead + 1)
        return image.crop((0, 0, image.width, end))

    @staticmethod
    def _turn(image, head_width: int):
        """Rotate a composed strip so it prints along the paper.

        Anything deeper than the head is wide cannot be printed at all in this
        direction, so it is trimmed rather than silently scaled, which would
        change the type size the user chose.
        """
        Session.trimmed = image.height > head_width
        if Session.trimmed:
            image = image.crop((0, 0, image.width, head_width))

        turned = image.transpose(Image.ROTATE_270)
        if turned.width < head_width:
            # The head prints the full width of the paper whatever is on it, so
            # a strip shallower than that leaves bare paper. It goes at the
            # start of the width, where a page begins, and the spare paper ends
            # up after it rather than before.
            padded = Image.new("RGB", (head_width, turned.height), "white")
            padded.paste(turned, (head_width - turned.width, 0))
            return padded
        return turned

    def render_for_print(self, text: str, options: Dict[str, Any]):
        # process() inverts polarity for the raster protocol, where a set bit
        # means a fired dot. That is what goes on the wire.
        image, processor = self._pipeline(text, options)
        return processor.process(image)

    def render_preview(self, text: str, options: Dict[str, Any]):
        # get_full_preview re-inverts, so the browser sees black ink on white
        # paper rather than the printer's bit pattern.
        image, processor = self._pipeline(text, options)
        return processor.get_full_preview(image)

    # --- connection ----------------------------------------------------------
    def connect(self, name: str) -> Tuple[bool, str]:
        profile = profiles.find_profile(name)
        if profile is None:
            return False, f"No saved profile named {name!r}"

        transport = profile.get("transport")
        address = profile.get("address", "")

        with self.lock:
            try:
                if self.printer.is_connected:
                    self.printer.disconnect()

                if transport == profiles.TRANSPORT_BLUETOOTH:
                    ok = self.printer.connect(address, device_name=profile["name"])
                elif transport == profiles.TRANSPORT_USB:
                    ok = self.printer.connect_usb(address)
                else:
                    ok = self.printer.connect_cups(address)
            except Exception as error:
                logger.warning("Connect failed: %s", error)
                self.last_error = str(error)
                return False, str(error)

        if ok:
            profiles.set_active(profile["name"])
            self.last_error = None
            return True, "connected"
        return False, "Could not open the device"

    def disconnect(self) -> None:
        with self.lock:
            if self.printer.is_connected:
                self.printer.disconnect()

    # --- printing ------------------------------------------------------------
    def print_image(self, image, feed_dots: int = 0) -> Tuple[bool, str]:
        """Print a page that is already a picture.

        Calendars, labels and calibration strips are drawn rather than set from
        markdown, so they come here instead of through print_text. Everything
        after the rendering is the same, and lives in one place.
        """
        if not self.printer.is_connected:
            return False, "Not connected to a printer"

        processor = ImageProcessor(
            brightness=1.0, contrast=1.0, auto_resize=False,
            printer_width=get_printer_width(),
        )
        return self._send(processor.process(image), feed_dots or None)

    def print_text(self, text: str, options: Dict[str, Any]) -> Tuple[bool, str]:
        if not self.printer.is_connected:
            return False, "Not connected to a printer"

        return self._send(self.render_for_print(text, options), None)

    def build_stream(self, image, feed_dots: Optional[int] = None) -> bytes:
        """The exact bytes a print would put on the wire, without printing.

        Kept next to _send and built the same way, so what is inspected is what
        would be sent rather than a reconstruction of it.
        """
        gap_dots = feed_dots if feed_dots is not None else mm_to_dots(get_tear_gap_mm())
        driver = get_driver()
        stream = bytearray(driver.prologue())
        for band in driver.bands(image):
            stream += band
        stream += driver.epilogue(gap_dots)
        return bytes(stream)

    def _send(self, image, feed_dots: Optional[int]) -> Tuple[bool, str]:
        gap_dots = feed_dots if feed_dots is not None else mm_to_dots(get_tear_gap_mm())

        # the printer's language, which is ESC/POS unless the profile says it
        # is a label printer and speaks TSPL instead
        driver = get_driver()

        with self.lock:
            try:
                self.printer.send_raw(driver.prologue())
                for band in driver.bands(image):
                    self.printer.send_image(band)
                self.printer.send_raw(driver.epilogue(gap_dots))
                self.printer.drain()
            except Exception as error:
                logger.warning("Print failed: %s", error)
                self.last_error = str(error)
                return False, str(error)

        return True, f"Printed {image.height} rows"

    # --- state ---------------------------------------------------------------
    def state(self) -> Dict[str, Any]:
        active = profiles.get_active()
        return {
            "connected": self.printer.is_connected,
            "activeProfile": active["name"] if active else None,
            "profiles": [
                {
                    "name": p.get("name"),
                    "transport": p.get("transport"),
                    "address": p.get("address"),
                    "capabilityProfile": p.get("capability_profile"),
                    "tearGapMm": p.get("tear_gap_mm", 0),
                }
                for p in profiles.list_profiles()
            ],
            "capabilityProfiles": get_profile_labels(),
            "width": get_printer_width(),
            "dpi": get_dpi(),
            # the paper is wider than the head: 58 mm rolls print 48 mm of it.
            # Both numbers go out so the preview can show the difference rather
            # than leave it to be discovered on paper.
            "paperWidthMm": get_printer_width_mm(),
            "printWidthMm": round(get_printer_width() * 25.4 / get_dpi(), 1),
            "dotsPerMm": round(get_dpi() / 25.4, 3),
            "tearGapMm": get_tear_gap_mm(),
            "lastError": self.last_error,
        }


SESSION: Optional[Session] = None


# -----------------------------------------------------------------------------
# routing
# -----------------------------------------------------------------------------
Route = Tuple[str, re.Pattern, Callable]
ROUTES = []


def route(method: str, pattern: str):
    compiled = re.compile(f"^{pattern}$")

    def register(function):
        ROUTES.append((method, compiled, function))
        return function
    return register


# --- helpers shared by the picture-shaped endpoints --------------------------
def _png(handler, image: Image.Image):
    buffer = io.BytesIO()
    image.convert("L").save(buffer, format="PNG", optimize=True)
    return 200, ("image/png", buffer.getvalue())


def _fit(image: Image.Image) -> Image.Image:
    """Scale a rendered page to the paper, and never past it."""
    width = get_printer_width()
    if image.width == width:
        return image
    height = max(1, round(image.height * width / image.width))
    return image.resize((width, height), Image.LANCZOS)


def _parse_date(value) -> Optional[datetime.datetime]:
    try:
        return datetime.datetime.strptime(str(value), "%Y-%m-%d")
    except (TypeError, ValueError):
        return None


def _print_image(image: Image.Image, feed_dots: int = 0):
    ok, message = SESSION.print_image(image, feed_dots=feed_dots)
    return (200 if ok else 400), {"ok": ok, "message": message}


def _tear_sample(mm: float) -> Image.Image:
    """A short page whose last line is where the tear should land."""
    from PIL import ImageDraw

    width = get_printer_width()
    font = get_font_manager().load_font(family=DEFAULT_FONT, size=22)
    line_height = 32
    height = line_height * (TEAR_CALIBRATION_LINES + 1) + 12
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)

    draw.text((10, 6), f"TEAR TEST {mm:g}mm", font=font, fill="black")
    for line in range(1, TEAR_CALIBRATION_LINES):
        draw.text((10, 6 + line * line_height), "." * 24, font=font, fill="black")
    rule_y = height - 8
    draw.line([(0, rule_y), (width, rule_y)], fill="black", width=3)
    return image


# --- state ---
@route("GET", "/api/state")
def api_state(handler, match, body):
    return 200, SESSION.state()


@route("POST", "/api/emulate")
def api_emulate(handler, match, body):
    """Read a byte stream back as paper.

    Two uses. Given `hex` or `base64`, it reads a capture from anywhere, which
    is how a stream from another app can be compared with this one's. Given
    `text` and `options`, it builds what a print of that document would send
    and reads that back, which answers whether a page that came out wrong was
    composed wrong or sent wrong.
    """
    raw = b""
    if body.get("hex"):
        try:
            raw = bytes.fromhex(re.sub(r"[\s,]|0x", "", str(body["hex"])))
        except ValueError:
            return 400, {"ok": False, "message": "That is not hex"}
    elif body.get("base64"):
        try:
            raw = base64.b64decode(str(body["base64"]), validate=True)
        except (binascii.Error, ValueError):
            return 400, {"ok": False, "message": "That is not base64"}
    else:
        options = body.get("options") or {}
        image = SESSION.render_for_print(body.get("text") or " ", options)
        raw = SESSION.build_stream(image, body.get("feedDots"))

    if len(raw) > 32 * 1024 * 1024:
        return 400, {"ok": False, "message": "That stream is too large to read"}

    result = emulate(raw, get_printer_width())
    buffer = io.BytesIO()
    result["image"].convert("L").save(buffer, format="PNG")
    return 200, {
        "ok": True,
        "bytes": result["bytes"],
        "height": result["height"],
        "width": result["width"],
        "cuts": result["cuts"],
        # text is reported for completeness but can be a whole receipt, so the
        # listing is capped: the first commands are the ones that go wrong
        "events": [
            {**event, "detail": str(event["detail"])[:120]}
            for event in result["events"][:400]
        ],
        "truncated": len(result["events"]) > 400,
        "png": "data:image/png;base64,"
               + base64.b64encode(buffer.getvalue()).decode("ascii"),
    }


@route("GET", "/api/status")
def api_status(handler, match, body):
    """Ask the printer how it is: paper, cover, head, cutter.

    Deliberately not part of /api/state, which the page polls: this one talks
    to the hardware and waits for an answer, and it takes the print lock so a
    status query cannot interleave with a job on the same socket. Printers that
    do not answer are not broken, they are quiet, and that is said as much.
    """
    if not SESSION.printer.is_connected:
        return 200, {"connected": False, "answered": False,
                     "ok": None, "flags": [], "messages": []}
    with SESSION.lock:
        status = SESSION.printer.read_status()
    return 200, {"connected": True, **status}


@route("GET", "/api/fonts")
def api_fonts(handler, match, body):
    """Every family installed on this machine, in alphabetical order.

    A font installed while this is running should turn up in the list the next
    time the list is asked for, not the next time the app is restarted, so the
    font directories are stamped and rescanned when one has moved. `?refresh=1`
    scans regardless, which is what the app asks for when it starts and what
    the Rescan button sends: a stamp can miss an install that leaves every
    directory mtime alone, and a list missing the font someone just installed
    is the one failure nobody can work around.
    """
    manager = get_font_manager()
    forced = (handler.query.get("refresh", ["0"])[0] or "").lower() not in ("", "0", "false")
    if forced:
        manager.refresh()
    else:
        manager.refresh_if_changed()
    families = manager.get_available_families() or [DEFAULT_FONT]
    return 200, {"fonts": families, "default": DEFAULT_FONT, "count": len(families)}


@route("GET", "/api/themes")
def api_themes(handler, match, body):
    return 200, {"themes": load_themes()}


@route("GET", r"/themes/user/(?P<name>[A-Za-z0-9._-]+\.css)")
def api_user_theme(handler, match, body):
    target = (USER_THEMES_DIR / match.group("name")).resolve()
    if target.parent != USER_THEMES_DIR.resolve() or not target.is_file():
        return 404, {"error": "not found"}
    return 200, ("text/css", target.read_bytes())


@route("GET", "/api/dither")
def api_dither(handler, match, body):
    return 200, {
        "modes": [{"id": mode, "label": DITHER_LABELS.get(mode, mode)} for mode in DITHER_MODES],
        "default": "floyd-steinberg",
        # what happens to the picture before it is screened: a photograph and a
        # scan of a page want different treatment, and no amount of dithering
        # fixes a flat scan
        "prefilters": [
            {"id": name, "label": PREFILTER_LABELS.get(name, name)}
            for name in PREFILTERS
        ],
        "prefilter_default": "none",
    }


@route("GET", "/api/symbols")
def api_symbols(handler, match, body):
    """The glyph table, grouped, for the picker.

    Sent whole rather than searched here: it is a few tens of kilobytes and
    never changes, so the browser can hold it and search it as you type.
    """
    return 200, {
        "groups": [
            {"name": name,
             "symbols": [{"char": char, "name": label, "use": use}
                         for char, label, use in symbols]}
            for name, symbols in SYMBOL_GROUPS.items()
        ]
    }


@route("POST", "/api/calendar")
def api_calendar(handler, match, body):
    """Render a month or a week as a page, in the paper's own width."""
    renderer = CalendarRenderer(font_size=int(body.get("size") or 14))
    try:
        if (body.get("range") or "month") == "week":
            image = renderer.render_week(_parse_date(body.get("date")))
        else:
            today = datetime.date.today()
            image = renderer.render_month(
                int(body.get("year") or today.year),
                int(body.get("month") or today.month),
            )
    except (ValueError, IndexError, KeyError) as error:
        return 400, {"error": str(error)}

    if body.get("print"):
        return _print_image(_fit(image))
    return _png(handler, _fit(image))


def _template_path(name: str):
    """Find a label background by file name, shipped or the user's own.

    Both directories are searched and neither can be escaped: a name that
    resolves anywhere else is simply not a template.
    """
    if not name:
        return None
    for directory in (TEMPLATES_DIR, USER_TEMPLATES_DIR):
        target = (directory / name).resolve()
        if target.parent == directory.resolve() and target.is_file():
            return target
    return None


@route("GET", "/api/templates")
def api_templates(handler, match, body):
    """The label backgrounds on offer, with their sizes.

    A caller needs the size to place text on one, since the coordinates are in
    the template's own pixels rather than the paper's. The user's own
    backgrounds come after the shipped ones and are marked, since those are the
    ones that can be deleted again.
    """
    entries = []
    for directory, mine in ((TEMPLATES_DIR, False), (USER_TEMPLATES_DIR, True)):
        for path in sorted(directory.glob("*.png")):
            try:
                with Image.open(path) as picture:
                    width, height = picture.size
            except OSError:
                continue
            entries.append({"name": path.stem, "file": path.name,
                            "width": width, "height": height, "mine": mine})
    return 200, {"templates": entries}


@route("POST", "/api/templates")
def api_template_upload(handler, match, body):
    """Keep a picture as a label background of its own.

    The image is taken as it comes and only converted, not resized: the
    coordinates text is placed at are the background's own pixels, and the
    printer's width is applied once, at the end, when the label is rendered.
    """
    data_url = body.get("data") or ""
    parsed = re.match(r"data:image/(?P<kind>[a-z+]+);base64,(?P<payload>.+)", data_url, re.S)
    if not parsed:
        return 400, {"ok": False, "message": "Expected an image data URL"}

    try:
        raw = base64.b64decode(parsed.group("payload"))
    except (ValueError, binascii.Error):
        return 400, {"ok": False, "message": "Could not decode that image"}
    if len(raw) > MAX_IMAGE_BYTES:
        return 400, {"ok": False, "message": "That image is larger than 8 MB"}

    try:
        picture = Image.open(io.BytesIO(raw))
        picture.load()
    except Exception:
        return 400, {"ok": False, "message": "That file is not an image"}

    stem = _slug(body.get("name") or "label") or "label"
    USER_TEMPLATES_DIR.mkdir(parents=True, exist_ok=True)
    name = f"{stem}.png"
    index = 2
    while (USER_TEMPLATES_DIR / name).exists():
        name = f"{stem}-{index}.png"
        index += 1

    picture.convert("RGB").save(USER_TEMPLATES_DIR / name, format="PNG")
    return 200, {"ok": True, "file": name, "name": Path(name).stem,
                 "width": picture.width, "height": picture.height, "mine": True}


@route("DELETE", r"/api/templates/(?P<name>[A-Za-z0-9._-]+\.png)")
def api_template_delete(handler, match, body):
    """Remove one of the user's own backgrounds. The shipped ones stay put."""
    target = (USER_TEMPLATES_DIR / match.group("name")).resolve()
    if target.parent != USER_TEMPLATES_DIR.resolve() or not target.is_file():
        return 404, {"ok": False, "message": "not one of yours"}
    target.unlink()
    return 200, {"ok": True}


@route("GET", r"/templates/(?P<name>[A-Za-z0-9._-]+\.png)")
def api_template_file(handler, match, body):
    target = _template_path(match.group("name"))
    if not target:
        return 404, {"error": "not found"}
    return 200, ("image/png", target.read_bytes())


@route("GET", "/api/labels")
def api_labels(handler, match, body):
    return 200, {"labels": _read_json(LABELS_FILE, [])}


@route("POST", "/api/labels")
def api_label_save(handler, match, body):
    """Save a background and the blocks on it under a name, to come back to.

    Saving over a name replaces it, which is what saving a label you have just
    changed is meant to do.
    """
    name = str(body.get("name") or "").strip()
    if not name:
        return 400, {"ok": False, "message": "That label needs a name"}
    entry = {
        "name": name,
        "template": str(body.get("template") or ""),
        "areas": body.get("areas") or [],
    }
    with _store_lock:
        labels = [item for item in _read_json(LABELS_FILE, [])
                  if item.get("name") != name]
        labels.append(entry)
        labels.sort(key=lambda item: item.get("name", "").lower())
        _write_json(LABELS_FILE, labels)
    return 200, {"ok": True, "labels": labels}


@route("DELETE", r"/api/labels/(?P<name>.+)")
def api_label_delete(handler, match, body):
    wanted = unquote(match.group("name"))
    with _store_lock:
        labels = [item for item in _read_json(LABELS_FILE, [])
                  if item.get("name") != wanted]
        _write_json(LABELS_FILE, labels)
    return 200, {"ok": True, "labels": labels}


@route("POST", "/api/label")
def api_label(handler, match, body):
    """Compose text onto a label background and preview or print it."""
    target = _template_path(str(body.get("template") or ""))
    if not target:
        return 400, {"error": "no such template"}

    with Image.open(target) as picture:
        background = picture.convert("RGB")

    renderer = LabelRenderer(template=background, target_width=get_printer_width())
    areas = [TextAreaConfig.from_dict(area) for area in body.get("areas") or []]
    darkness = float(body.get("darkness") or 1.5)
    image = renderer.get_print_image(areas, darkness=darkness)
    if image is None:
        return 400, {"error": "nothing to render"}

    if body.get("print"):
        return _print_image(image)
    return _png(handler, image)


@route("POST", "/api/tear-test")
def api_tear_test(handler, match, body):
    """Print a strip that ends in a line, then feed the gap being tried.

    Calibration is a physical question, so it is answered physically: print
    this, tear it off, and see whether the tear landed on the line.
    """
    gap = max(0.0, min(MAX_TEAR_GAP_MM, float(body.get("mm") or 0)))
    image = _tear_sample(gap)
    ok, message = SESSION.print_image(image, feed_dots=mm_to_dots(gap))
    return (200 if ok else 400), {"ok": ok, "message": message, "mm": gap}


@route("POST", "/api/images")
def api_image_upload(handler, match, body):
    """Take a data URL from the editor and keep it as a file.

    Named by the hash of its contents, so inserting the same picture twice
    costs one copy and a document that references it keeps working.
    """
    data_url = body.get("data") or ""
    match_data = re.match(r"data:image/(?P<kind>[a-z+]+);base64,(?P<payload>.+)", data_url, re.S)
    if not match_data:
        return 400, {"ok": False, "message": "Expected an image data URL"}

    try:
        raw = base64.b64decode(match_data.group("payload"))
    except (ValueError, binascii.Error):
        return 400, {"ok": False, "message": "Could not decode that image"}

    if len(raw) > MAX_IMAGE_BYTES:
        return 400, {"ok": False, "message": "That image is larger than 8 MB"}

    try:
        image = Image.open(io.BytesIO(raw))
        image.verify()
    except Exception:
        return 400, {"ok": False, "message": "That file is not an image"}

    name = f"{hashlib.sha256(raw).hexdigest()[:16]}.png"
    target = IMAGES_DIR / name
    if not target.exists():
        IMAGES_DIR.mkdir(parents=True, exist_ok=True)
        Image.open(io.BytesIO(raw)).convert("RGB").save(target, format="PNG")

    return 200, {"ok": True, "url": f"/images/{name}"}


@route("GET", r"/images/(?P<name>[A-Za-z0-9._-]+)")
def api_image(handler, match, body):
    target = (IMAGES_DIR / match.group("name")).resolve()
    if target.parent != IMAGES_DIR.resolve() or not target.is_file():
        return 404, {"error": "not found"}
    kind = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
    return 200, (kind, target.read_bytes())


@route("GET", "/api/devices")
def api_devices(handler, match, body):
    transport = handler.query.get("transport", [profiles.TRANSPORT_BLUETOOTH])[0]
    if transport == profiles.TRANSPORT_USB:
        found = list_usb_devices()
    elif transport == profiles.TRANSPORT_CUPS:
        found = list_cups_queues()
    else:
        found = list_bluetooth_devices()
    return 200, {"devices": [{"label": l, "value": v} for l, v in found]}


# --- connection ---
@route("POST", "/api/connect")
def api_connect(handler, match, body):
    ok, message = SESSION.connect(body.get("profile", ""))
    return (200 if ok else 400), {"ok": ok, "message": message, "state": SESSION.state()}


@route("POST", "/api/disconnect")
def api_disconnect(handler, match, body):
    SESSION.disconnect()
    return 200, {"ok": True, "state": SESSION.state()}


# --- device profiles ---
@route("POST", "/api/profiles")
def api_profile_save(handler, match, body):
    original = body.get("originalName")
    # editing a device sends what the form holds, which is not the calibrated
    # gap: that was measured against this printer's body and has no business
    # being reset by a change of name
    gap = body.get("tearGapMm")
    if gap is None:
        existing = profiles.find_profile(original or body.get("name", ""))
        gap = (existing or {}).get("tear_gap_mm", 0)

    try:
        name = profiles.save_profile(
            name=body.get("name", ""),
            transport=body.get("transport", profiles.TRANSPORT_BLUETOOTH),
            address=body.get("address", ""),
            capability_profile=body.get("capabilityProfile", ""),
            tear_gap_mm=gap,
            original_name=original,
        )
    except ValueError as error:
        return 400, {"ok": False, "message": str(error)}
    return 200, {"ok": True, "name": name, "state": SESSION.state()}


@route("GET", "/api/printer-types")
def api_printer_types(handler, match, body):
    """Every capability profile on offer, and what each one claims.

    The dialog needs more than the labels when a type is being edited: the head
    width, the dpi and the feature flags are the fields it fills in.
    """
    entries = []
    for key, profile in load_printer_profiles().items():
        media = profile.get("media", {}) or {}
        width = media.get("width", {}) or {}
        entries.append({
            "key": key,
            "name": profile.get("name", key),
            "vendor": profile.get("vendor", ""),
            "dpi": media.get("dpi", 203),
            "widthDots": width.get("pixels", 384),
            "widthMm": width.get("mm", 57.5),
            "features": profile.get("features", {}) or {},
            "notes": profile.get("notes", ""),
            "custom": bool(profile.get("custom")),
            # the protocol side of a type: which opcode carries a bitmap, how
            # fast the printer can be fed, which cut it answers to, and the two
            # byte sequences some printers need around a job
            "driver": profile.get("driver", "escpos"),
            "graphics": profile.get("graphics", "gsv0"),
            "flow": {**FLOW_DEFAULTS, **(profile.get("flow") or {})},
            "cut": {"full": "gsv0", "partial": "gsv1", "feed_dots": 0,
                    **(profile.get("cut") or {})},
            "density": {"supported": False, "level": 0,
                        **(profile.get("density") or {})},
            "commands": profile.get("commands", {}) or {},
        })
    entries.sort(key=lambda entry: (entry["custom"], entry["name"].lower()))
    return 200, {
        "types": entries,
        "driverOptions": [{"id": key, "label": label}
                          for key, label in DRIVER_LABELS.items()],
        "graphicsOptions": [{"id": key, "label": label}
                            for key, label in GRAPHICS_COMMANDS.items()],
        "cutOptions": [{"id": key, "label": label}
                       for key, label in PrinterProtocol.CUT_LABELS.items()],
        "flowDefaults": FLOW_DEFAULTS,
    }


@route("POST", "/api/printer-types")
def api_printer_type_save(handler, match, body):
    """Describe a printer nobody wrote a profile for.

    The schema is escpos-printer-db's, so an entry written here says the same
    thing to python-escpos or escpos-php as it does to this app. Width is taken
    in dots, since that is what the raster protocol counts in, and rounded down
    to a whole byte because eight dots share one.
    """
    name = str(body.get("name") or "").strip()
    if not name:
        return 400, {"ok": False, "message": "That printer type needs a name"}

    try:
        dots = int(body.get("widthDots") or 384)
        dpi = int(body.get("dpi") or 203)
    except (TypeError, ValueError):
        return 400, {"ok": False, "message": "Width and dpi have to be numbers"}
    dots = max(64, min(2048, dots - (dots % 8)))
    dpi = max(50, min(600, dpi))

    try:
        width_mm = round(float(body.get("widthMm") or 0) or dots * 25.4 / dpi, 2)
    except (TypeError, ValueError):
        width_mm = round(dots * 25.4 / dpi, 2)

    wanted = body.get("features") or {}
    features = {
        flag: bool(wanted.get(flag))
        for flag in ("bitImageRaster", "qrCode", "barcodeA",
                     "paperFullCut", "paperPartCut")
    }

    # Some printers want a byte sequence before a job and another after it:
    # a mode reset, a character set, a line feed the firmware forgets. Taken as
    # hex because that is how every datasheet writes them, and refused rather
    # than silently dropped when they are not hex, so a typo is visible here
    # instead of on paper.
    # A type that is being edited keeps the sequences the form does not ask
    # about, so copying a shipped profile does not quietly drop its status
    # request.
    known = load_printer_profiles().get(str(body.get("key") or ""), {})
    commands = dict(known.get("commands") or {})
    for field in ("start_print", "end_print", "status_request"):
        sent = (body.get("commands") or {}).get(field)
        if sent is None:
            commands.setdefault(field, "")
            continue
        raw = re.sub(r"[\s,]|0x", "", str(sent))
        if raw:
            try:
                bytes.fromhex(raw)
            except ValueError:
                return 400, {"ok": False,
                             "message": f"{field.replace('_', ' ')} is not hex"}
        commands[field] = raw.lower()

    wanted_flow = body.get("flow") or {}
    flow = dict(FLOW_DEFAULTS)
    for field in flow:
        try:
            flow[field] = type(flow[field])(wanted_flow[field])
        except (KeyError, TypeError, ValueError):
            pass

    wanted_cut = body.get("cut") or {}
    wanted_density = body.get("density") or {}
    try:
        feed_dots = max(0, min(600, int(wanted_cut.get("feed_dots") or 0)))
        level = max(0, min(8, int(wanted_density.get("level") or 0)))
    except (TypeError, ValueError):
        feed_dots, level = 0, 0

    key = str(body.get("key") or "").strip() or f"custom-{_slug(name) or 'printer'}"
    profile = {
        "name": name,
        "vendor": str(body.get("vendor") or "Custom"),
        "media": {"dpi": dpi, "width": {"mm": width_mm, "pixels": dots}},
        "features": features,
        "commands": commands,
        "driver": ("tspl" if str(body.get("driver")) == "tspl" else "escpos"),
        "graphics": str(body.get("graphics") or "gsv0"),
        "flow": flow,
        "cut": {
            "full": str(wanted_cut.get("full") or "gsv0"),
            "partial": str(wanted_cut.get("partial") or "gsv1"),
            "feed_dots": feed_dots,
        },
        "density": {
            "supported": bool(wanted_density.get("supported")),
            "level": level,
        },
        "notes": str(body.get("notes") or "Described in the app."),
    }
    save_user_printer_profile(key, profile)
    return 200, {"ok": True, "key": key, "state": SESSION.state()}


@route("DELETE", r"/api/printer-types/(?P<key>.+)")
def api_printer_type_delete(handler, match, body):
    if not delete_user_printer_profile(unquote(match.group("key"))):
        return 404, {"ok": False, "message": "not one of yours"}
    return 200, {"ok": True, "state": SESSION.state()}


@route("DELETE", "/api/profiles/(?P<name>.+)")
def api_profile_delete(handler, match, body):
    from urllib.parse import unquote
    profiles.delete_profile(unquote(match.group("name")))
    return 200, {"ok": True, "state": SESSION.state()}


@route("GET", "/api/network")
def api_network(handler, match, body):
    return 200, {
        "exposed": network_exposed(),
        "host": listen_host(),
        "port": PORT,
        "override": HOST_OVERRIDE,
        "addresses": local_addresses(),
        "rawPort": raw_port_enabled(),
        "rawPortNumber": RAW_PORT,
        "rawPortOpen": _raw_server is not None,
    }


@route("POST", "/api/network")
def api_network_set(handler, match, body):
    """Open the server to the network, or close it again.

    There is no authentication, so this is the whole of the security model:
    whoever can reach the port can print. The response goes out before the
    listener is replaced, so the caller hears the answer on the old socket.
    """
    exposed = bool(body.get("exposed"))
    if HOST_OVERRIDE:
        return 400, {"ok": False,
                     "message": f"THERMAL_WEB_HOST is set to {HOST_OVERRIDE}, "
                                "so the app cannot change this"}
    if exposed == network_exposed():
        return 200, {"ok": True, "exposed": exposed, "host": listen_host(),
                     "port": PORT, "addresses": local_addresses()}

    set_network_exposed(exposed)
    request_rebind()
    return 200, {"ok": True, "exposed": exposed, "host": listen_host(),
                 "port": PORT, "addresses": local_addresses(),
                 "message": "Listening on {} now".format(listen_host())}


@route("POST", "/api/raw-port")
def api_raw_port(handler, match, body):
    """Open or close the raw printing port.

    It follows the web listener: local only unless the app is exposed to the
    network, since it is the same decision with fewer questions asked. There is
    no authentication on it either, and anything that reaches it prints.
    """
    wanted = bool(body.get("enabled"))
    set_raw_port_enabled(wanted)
    if wanted:
        opened = start_raw_port()
        if opened is None:
            return 200, {"ok": False, "enabled": True, "open": False,
                         "message": f"Port {RAW_PORT} is in use by something else"}
    else:
        stop_raw_port()
    return 200, {"ok": True, "enabled": wanted, "open": _raw_server is not None,
                 "port": RAW_PORT, "host": listen_host()}


@route("POST", "/api/tear-gap")
def api_tear_gap(handler, match, body):
    set_tear_gap_mm(float(body.get("mm", 0)))
    return 200, {"ok": True, "state": SESSION.state()}


# --- preview + print ---
@route("POST", "/api/preview")
def api_preview(handler, match, body):
    image = SESSION.render_preview(body.get("text", ""), body.get("options", {}))
    buffer = io.BytesIO()
    image.convert("L").save(buffer, format="PNG", optimize=True)
    # the page itself cannot say that some of it was cut off, so the response does
    handler.extra_headers = {"X-Trimmed": "1" if SESSION.trimmed else "0"}
    return 200, ("image/png", buffer.getvalue())


@route("POST", "/api/print")
def api_print(handler, match, body):
    ok, message = SESSION.print_text(body.get("text", ""), body.get("options", {}))
    return (200 if ok else 400), {"ok": ok, "message": message}


# --- presets ---
@route("GET", "/api/presets")
def api_presets(handler, match, body):
    return 200, {"presets": load_presets()}


@route("POST", "/api/presets")
def api_preset_save(handler, match, body):
    name = (body.get("name") or "").strip()
    if not name:
        return 400, {"ok": False, "message": "A preset needs a name"}

    with _store_lock:
        presets = load_presets()
        entry = {
            "id": body.get("id") or uuid.uuid4().hex[:12],
            "name": name,
            "description": (body.get("description") or "").strip(),
            "text": body.get("text", ""),
            # a preset carries the render settings it was designed against, so
            # reopening one does not silently print at whatever size was last used
            "options": {
                "font": body.get("options", {}).get("font") or DEFAULT_FONT,
                "size": int(body.get("options", {}).get("size") or DEFAULT_SIZE),
                "darkness": float(body.get("options", {}).get("darkness") or 1.0),
            },
            "updated": time.time(),
        }
        for index, existing in enumerate(presets):
            if existing.get("id") == entry["id"]:
                presets[index] = entry
                break
        else:
            presets.append(entry)
        _write_json(PRESETS_FILE, presets)

    return 200, {"ok": True, "preset": entry, "presets": presets}


@route("DELETE", "/api/presets/(?P<id>[a-z0-9]+)")
def api_preset_delete(handler, match, body):
    with _store_lock:
        presets = [p for p in load_presets() if p.get("id") != match.group("id")]
        _write_json(PRESETS_FILE, presets)
    return 200, {"ok": True, "presets": presets}


# --- to-dos ---
@route("GET", "/api/todos")
def api_todos(handler, match, body):
    return 200, {"todos": load_todos()}


@route("POST", "/api/todos")
def api_todo_add(handler, match, body):
    text = (body.get("text") or "").strip()
    if not text:
        return 400, {"ok": False, "message": "Empty item"}
    with _store_lock:
        todos = load_todos()
        todos.append({"id": uuid.uuid4().hex[:12], "text": text, "done": False})
        _write_json(TODOS_FILE, todos)
    return 200, {"ok": True, "todos": todos}


@route("PATCH", "/api/todos/(?P<id>[a-z0-9]+)")
def api_todo_toggle(handler, match, body):
    with _store_lock:
        todos = load_todos()
        for todo in todos:
            if todo.get("id") == match.group("id"):
                todo["done"] = bool(body.get("done", not todo.get("done")))
                if "text" in body:
                    todo["text"] = body["text"]
        _write_json(TODOS_FILE, todos)
    return 200, {"ok": True, "todos": todos}


@route("DELETE", "/api/todos/(?P<id>[a-z0-9]+)")
def api_todo_delete(handler, match, body):
    with _store_lock:
        todos = [t for t in load_todos() if t.get("id") != match.group("id")]
        _write_json(TODOS_FILE, todos)
    return 200, {"ok": True, "todos": todos}


@route("POST", "/api/todos/clear-done")
def api_todo_clear(handler, match, body):
    with _store_lock:
        todos = [t for t in load_todos() if not t.get("done")]
        _write_json(TODOS_FILE, todos)
    return 200, {"ok": True, "todos": todos}


# -----------------------------------------------------------------------------
# http plumbing
# -----------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    server_version = "ThermalPrinterWeb/1.0"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        logger.debug("%s - %s", self.address_string(), fmt % args)

    # --- helpers ---
    def _send(self, status: int, payload) -> None:
        if isinstance(payload, tuple):          # (content_type, raw bytes)
            content_type, data = payload
        else:
            content_type = "application/json"
            data = json.dumps(payload).encode()

        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        # this is a localhost tool; no caching keeps edits visible immediately
        self.send_header("Cache-Control", "no-store")
        # anything a handler wanted to say about the payload rather than in it
        for name, value in getattr(self, "extra_headers", {}).items():
            self.send_header(name, value)
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {}

    def _serve_static(self, path: str) -> None:
        relative = path.lstrip("/") or "index.html"
        target = (STATIC_DIR / relative).resolve()

        # never serve outside the static directory
        if not str(target).startswith(str(STATIC_DIR.resolve())):
            self._send(403, {"error": "forbidden"})
            return
        if target.is_dir():
            target = target / "index.html"
        if not target.is_file():
            self._send(404, {"error": "not found"})
            return

        content_type = mimetypes.guess_type(str(target))[0] or "application/octet-stream"
        self._send(200, (content_type, target.read_bytes()))

    def _dispatch(self, method: str) -> None:
        from urllib.parse import urlparse, parse_qs
        parsed = urlparse(self.path)
        self.query = parse_qs(parsed.query)

        for route_method, pattern, function in ROUTES:
            if route_method != method:
                continue
            match = pattern.match(parsed.path)
            if not match:
                continue
            try:
                status, payload = function(self, match, self._read_body())
            except Exception as error:
                logger.exception("Handler failed")
                status, payload = 500, {"ok": False, "message": str(error)}
            self._send(status, payload)
            return

        if method == "GET":
            self._serve_static(parsed.path)
        else:
            self._send(404, {"error": "no such endpoint"})

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")

    def do_PATCH(self):
        self._dispatch("PATCH")

    def do_DELETE(self):
        self._dispatch("DELETE")


def main() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    global SESSION
    SESSION = Session()
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    IMAGES_DIR.mkdir(parents=True, exist_ok=True)

    global SERVER, _rebind_wanted
    logger.info("Presets: %s", PRESETS_FILE)

    # A rebind stops the listener and starts another on the new address, so
    # this is a loop rather than a single serve_forever. Everything else about
    # the process, including an open printer connection, carries across.
    while True:
        host = listen_host()
        try:
            SERVER = ThreadingHTTPServer((host, PORT), Handler)
        except OSError as error:
            if host == LOCAL_HOST:
                raise
            logger.warning("Could not listen on %s (%s) - staying local", host, error)
            set_network_exposed(False)
            SERVER = ThreadingHTTPServer((LOCAL_HOST, PORT), Handler)
            host = LOCAL_HOST

        if host == OPEN_HOST:
            logger.warning("Open to the network on port %d, with no authentication", PORT)
        logger.info("Thermal Printer web UI on http://%s:%d", host, PORT)
        # the raw printing port, when it is wanted, on the same address
        start_raw_port()

        try:
            SERVER.serve_forever()
        except KeyboardInterrupt:
            logger.info("Shutting down")
            _rebind_wanted = False
        finally:
            SERVER.server_close()

        if not _rebind_wanted:
            break
        _rebind_wanted = False

    stop_raw_port()
    if SESSION.printer.is_connected:
        SESSION.disconnect()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
