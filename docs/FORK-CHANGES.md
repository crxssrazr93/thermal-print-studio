# Changes in this fork

Attribution for everything this builds on is in `doc/CREDITS.md`.

## 1. Not hardcoded to the CTP-500

Upstream targeted one printer. Three things were baked in:

- `PrinterProtocol.PRINTER_WIDTH = 384` was a class constant, and it was used as
  a **default argument value** in `TextRenderer`, `ImageProcessor`,
  `CalendarRenderer`, `LabelRenderer` and `BannerFrame`. Default arguments are
  evaluated at import time, so `printer.width` in `config.yaml` had no effect on
  rendering. Setting it to 576 for an 80mm printer changed nothing.
- The start/end/status byte sequences (`GS I f0 19`, `0x9a`, `RS G 3`) are CTP-500
  vendor extensions, not ESC/POS, and were sent unconditionally to every printer.
- A width that was not a multiple of 8 would desynchronise every raster row,
  with no guard.

Now:

- Capability profiles live in `src/config/data/printer_profiles.json`, using the
  **escpos-printer-db** schema so they are portable to python-escpos and
  escpos-php.
- `config/printer_profile.py` resolves width, capability flags and vendor
  commands **at call time**, so config changes take effect.
- Width is rounded down to a whole byte (580 → 576).
- An explicit `printer.width` overrides the profile, for hardware that does not
  quite match its profile.
- Profiles ship for generic 58mm, generic 80mm, NT-5890K and the CTP-500. The
  CTP-500 remains the default so existing users are unaffected.
- The profile is selectable in **Settings → Printer**, which also shows the
  resolved width and capabilities.

## 2. USB and CUPS transports

Upstream was Bluetooth-only: `connect()` took a MAC address and opened an RFCOMM
socket, and that was the sole path.

`src/core/transport.py` adds two socket-compatible transports, so the same code
drives all three:

- `UsbTransport` writes to `/dev/usb/lp*`. Opened non-blocking, so a printer
  that never replies cannot wedge the UI thread.
- `CupsTransport` spools via `lp -o raw` to any configured queue, covering USB,
  network and Bluetooth-backed queues.

New entry points: `PrinterConnection.connect_usb()`, `.connect_cups()`,
`.list_usb_devices()`, `.list_cups_destinations()`.

## 3. Native QR, barcode and paper cut

Previously everything had to be rasterised as an image. Added, each gated behind
the active profile's capability flags so unsupported printers are never sent
commands they would echo as garbage:

- `build_qr_command()`: `GS ( k`, guarded by `qrCode`
- `build_barcode_command()`: CODE128 via `GS k`, guarded by `barcodeA`
- `build_cut_command()`: `GS V`, guarded by `paperFullCut` / `paperPartCut`

## 4. Responsive layout

The control rows used `pack(side="left")` with hardcoded pixel widths
(`width=50/75/85/160/180/240`). They could neither shrink nor grow, so:

- Narrowing the window **silently clipped controls off the right edge**. Below
  roughly 840px the **Symbols** button and **Add Date** checkbox became
  unreachable. Not wrapped or scrolled, just gone. `MIN_WINDOW_WIDTH` was 600,
  so the window was resizable into a broken state.
- Widening left a large dead band; only the text area expanded.

`src/gui/widgets/flow_frame.py` adds a `FlowFrame` container that lays children
out left to right and **wraps onto a new row** when width runs out, reporting its
own height so the parent allocates correctly. Applied to the control rows in
`base_text_frame.py` and `image_frame.py`. At 640px wide the controls now wrap to
four rows with everything reachable.

## 5. Launcher fixes

- The shipped `.desktop` used
  `Exec=bash -c 'cd "$HOME/code/personal/print" && ./run.sh'`, an unquoted `&`
  and nested quotes, which fails `desktop-file-validate` and can be rejected by
  the launcher. `Exec` now points straight at `run.sh`.
- That required `run.sh` to set its own working directory (`cd "$SCRIPT_DIR"`),
  since `python -m src.main` only resolves with the repo root as cwd.

## 6. Saved device profiles

Connecting meant typing a MAC address or `/dev` path into a free-text field.
A device profile now bundles transport, address, capability profile and
calibrated tear gap, and the connection bar lists printers by name.
`core/device_discovery.py` enumerates Bluetooth (BlueZ over D-Bus, falling back
to `bluetoothctl`), USB (sysfs descriptors, falling back to the IEEE 1284 ID)
and CUPS queues.

Device listings no longer special-case the CTP-500: detection was a literal
match on the name "CorePrint" with a `[CTP]` tag, and is now a generic printer
heuristic over the name and the Serial Port Profile UUID.

## 7. Tear-off calibration

The head-to-tear-bar distance is physical, so it is measured rather than
guessed. Settings -> Printer -> Calibrate tear-off prints a sample at 1mm and
steps up in whole millimetres until confirmed, storing the result against the
profile.

Units follow the usual split: millimetres in the UI because that is what can be
measured, dot rows (`ESC J`) on the wire because that is the only precise unit
the printer understands. Feed *lines* are not used - quantised to 1/6 inch
(~4.2mm at 203 dpi), they cannot express a gap falling between two lines, which
is exactly the case on the test unit (8.5mm).

## 8. Markdown and LaTeX math

The Text tab renders headings, emphasis, lists, tables, code, quotes, rules and
links with live preview. There is no separate Markdown tab and no mode toggle:
plain text is valid markdown, so one input covers both and the user never has
to declare which they are typing.

Two deliberate deviations from CommonMark make that safe. A newline is a hard
line break rather than a soft wrap, because the user is describing what the
receipt should look like rather than authoring a source file that gets
re-flowed later. Emphasis also will not fire mid-word, so `2*3*4` and
`some_var_name` print literally instead of silently italicising.

A formatting toolbar sits above the editor. Its buttons edit the source rather
than styling it: wrapping a selection, prefixing every line the selection
touches, or inserting a skeleton with the placeholder left selected so the next
keystroke replaces it. Line prefixes toggle, so the same button turns a list
back into plain lines, and applying one block marker replaces another instead
of stacking on top of it.

The whole-document Bold, Italic and Align controls are hidden on this tab. The
markdown renderer accepts them and ignores them, since the source carries its
own emphasis and block structure, so leaving them visible would have meant
three controls that silently do nothing. The Banner tab still uses TextRenderer
and keeps them.

Display math (`$$...$$`) uses matplotlib's mathtext engine, which needs no TeX
installation; matplotlib is optional and the raw source prints when it is
absent.

MathML is deliberately unsupported - no usable pure-Python renderer exists, and
the alternatives are an external Java toolchain or a hand-written
MathML-to-LaTeX converter.

## 9. Editor and preview side by side

A receipt preview is a tall narrow strip, so stacking it under the editor gave
it a wide short box that showed only a few lines while taking height away from
the text. The two now sit side by side, which lets the preview use the full
window height and roughly triples how much of the output is visible at once.

That only holds while the window is wide enough. `AdaptivePaned` re-orients
itself as the window resizes: side by side above 820px, stacked below it, with
a 60px hysteresis band so the layout does not flip back and forth while a
window edge is dragged across the threshold. Dragging the sash pins it, and the
automatic placement stops overriding the choice until the orientation changes.

The Text, Banner and Template tabs all share the one widget rather than
repeating the splitter logic three times.

## 10. Bug fixes

- **USB jobs truncated.** `UsbTransport` opened the device `O_NONBLOCK` and
  closed immediately after the last write, dropping whatever the kernel had not
  yet handed to the printer. Writes are now blocking and `close()` drains first.
- **Every failed Bluetooth scan raised `NameError`.** The handler captured the
  exception variable in a lambda deferred via `after(0, ...)`; Python clears
  that variable when the `except` block ends.
- **Calibration could be lost.** `Settings.save()` is debounced behind a daemon
  timer, so a prompt close discarded it. Calibration uses `save_immediate()`.
- **Banner used the Text tab's line spacing**. The lookup hardcoded
  `SettingsKeys.Text` instead of the section accessor.
- **Calendar fallback was hardcoded to 384px**, ignoring the active profile.
- Removed a dead `PREVIEW_PAPER_WIDTH` constant and ~50 unused imports;
  portal file dialogs no longer swallow exceptions silently.

## 11. A server and a web app

The desktop GUI is gone. What replaced it is a stdlib-only print server with a
browser front end, so the app runs as a systemd user service at a fixed address
and printing is a tab away rather than a launch away. Rendering stayed in
Python, which is why the preview is the bitmap the head will receive rather
than a CSS impression of one, and it is why there is an HTTP API at all: the
browser is one client of it, and anything else can be another.

Everything the desktop app did lives in the web app, and a good deal it did
not: tables you type into, pictures with eleven screening methods, right to
left scripts, along the roll printing, labels, calendars, presets, a to-do
list, four themes that set the paper as well as the screen.

## 12. The protocol became data

Following a study of RawBT (`docs/rawbt-findings.md`), every constant that
decided whether a given printer worked at all moved into the profile:

- **`flow`**: bytes per write, the pause between writes, rows per image
  command, and how long to wait before closing. These were tuned against one
  machine and were the difference between a printed page and a streaked one.
- **`graphics`**: which opcode carries a bitmap. `GS v 0` is nearly universal
  and not quite; column mode (`ESC *`) is there for the firmwares that print
  the raster command as characters.
- **`cut`**: nine dialects, and the feed that carries the last line past the
  blade.
- **`density`**: how hard the head burns, which is not the same as darkening
  the bitmap.
- **`driver`**: which language the printer speaks, ESC/POS or TSPL.

All of it is editable in the app, under **How to talk to it** in the printer
type editor. Alongside: printer status decoded into words, a byte stream reader
that draws what a stream would print and names every command in it, a raw
listener on port 9100 so other software can print through this, and blank paper
trimmed off the end of every job rather than only off banners.

## 13. Type styles that keep the typeface

Bold and italic use the family's own files when it has them. When it does not,
the face it has is thickened (struck twice, a dot apart) or sheared about the
baseline, so the page stays in the chosen typeface. Before this, a family with
no italic printed its italics in DejaVu Sans Mono, and one with no bold printed
bold identical to regular.

Strikethrough is a real rule through the letters, placed from the face's
x height. It used to be faked with combining characters, which broke spaces,
quotes, tables and any font without those characters. Underline sits on the
face's baseline rather than at a fraction of the line height, so it stays put
when the line spacing changes.

Inline styles nest: `**bold ++under++**` is bold throughout and underlined at
the end, where before the plus signs printed. Subscript now drops below the
baseline instead of floating above it, and an upper case heading keeps its
underline, highlight and strike.

In the editor, the markdown source mode buttons for underline, highlight,
superscript, subscript, checklists and pictures work (they did nothing before),
and a style applied to a word with its trailing space no longer glues the
closing marker to the next word.

The font control is a dropdown with a search box over every installed family,
sorted A to Z, scrollable to the end, and rescanned at launch. Closed and focused, the arrow keys step
through the fonts and the page follows; typing a letter opens it searching for
that letter.

## Known limitations

- Render/process/print logic is still duplicated across the text, image,
  template and calendar frames.
- The CTP-500 vendor commands remain unverified on non-CTP-500 hardware; the
  `generic-*` profiles avoid them entirely.
- `CupsTransport` is spooled, not streaming. Bytes reach the printer as one job
  on `close()`, so interactive status reads are not meaningful on that path.
- The TSPL driver is written and untested. No label printer has been through
  it, so it is a starting point rather than a working driver.
