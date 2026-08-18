# Troubleshooting

## It will not connect

- Is the printer on, and is it paired? `bluetoothctl devices` lists what the
  machine knows about.
- Is anything else connected to it? These printers accept one connection at a
  time, so a phone that grabbed it first will hold it.
- `systemctl status bluetooth` for the daemon, and `bluetoothctl power on` if
  the adapter is off.
- After a failed print the printer can be left mid-job and stop responding.
  Power cycle it, then connect again.

## It prints streaks, or garbage after the first few lines

That was a real bug, fixed by sending the page a band at a time and writing
every band in full. If you see it on a build that has that fix, the printer is
probably being fed faster than it can burn. Settings, Add a device, Describe
one, **How to talk to it**: halve **Bytes per write** and raise **Pause between
writes** until it holds. Failing that, it is being fed by something else at the
same time, or the battery is low enough that the head is browning out.

## It says this Python was built without Bluetooth support

`AF_BLUETOOTH` is a compile-time option in CPython's socket module, and the
standalone interpreters that uv and pyenv download are built without it. USB and
CUPS still work; Bluetooth cannot, because there is no way to open an RFCOMM
socket.

Reinstall against a Python that has it, which on most systems is the packaged
one:

```bash
uv tool install --force --editable --python /usr/bin/python3 ~/Apps/thermal-printer
systemctl --user restart thermal-print-studio
```

`install.sh` now picks such an interpreter itself. To check any Python:

```bash
python3 -c 'import socket; print(hasattr(socket, "AF_BLUETOOTH"))'
```

## The desktop Bluetooth applet says it cannot connect

It is right, and it does not matter. These printers offer only the serial port
profile, which the desktop has no handler for, so its Connect button fails while
the app connects perfectly well: the app opens the RFCOMM socket itself. Pair
the printer in the applet, then leave the connecting to the app.

## Permission denied on USB

Your user needs to be in the group that owns the device node:

```bash
ls -l /dev/usb/lp0          # look at the group
sudo usermod -aG lp $USER   # then log out and back in
```

## Nothing happens when I press Print

Check the connection light in the top right of the window. If it says
Disconnected, the button did nothing because there was nothing to print to.
`journalctl --user -u thermal-print-studio -f` shows what the server thought.

## The preview is fine but the paper is not

- **Too light or too dark**: Darkness in Settings, and for pictures the Cutoff
  slider.
- **Cut off down one side**: the paper is 384 dots wide and that is the whole
  page; anything wider is not scaled, it is lost. Reduce the type size.
- **Cut off along the roll**: a strip is only as deep as the head is wide, and
  the preview warns when a page is deeper than that.

## A symbol prints as a box

The paper font does not carry that glyph. Change the font in Settings, or
install one with wider coverage: DejaVu Sans Mono and Noto Sans Mono between
them cover most of what the symbol picker offers. The preview is honest about
this, so if it shows a box, so will the paper.

## Arabic or Hebrew prints as separate letters

The text is not being shaped, which means Pillow was built without RAQM. Check
with:

```python
from PIL import features; print(features.check('raqm'))
```

If that says False, install `libraqm` and reinstall Pillow.

## A picture prints as its own markdown

Text pasted from a web page, particularly an Arabic or Hebrew one, carries
invisible direction marks. One of those landing inside `![alt](path)` used to
stop it being an image at all, so the markup printed as words, scrambled by the
bidi algorithm into something unrecognisable. The marks are tolerated now. If
you still see markup on the paper, read the line in **Raw** mode: the path is
probably wrong.

## Pictures print as pages of characters

The firmware does not know `GS v 0`, the raster command. Settings, Add a
device, Describe one, **How to talk to it**: set **Images are sent as** to one
of the column modes (`ESC *`), starting with the twenty four dot one. It is the
older way of sending a bitmap and nearly everything understands it.

## Something is wrong and it is not obvious which end

Settings has **What goes on the wire**. It reads the byte stream a print would
send and shows the paper it describes, with every command listed by offset and
length; anything it does not recognise is called out. If the picture there is
right, the bytes are right and the printer is the problem. If it is wrong, the
document or the profile is.

A `.prn` capture from another app can be pasted into the same box, which is how
to find out what that app sends differently on the same printer.

## The service will not start

```bash
systemctl --user status thermal-print-studio
journalctl --user -u thermal-print-studio -n 50
```

The usual causes are a port already in use (something else on 8760) and a
`~/.local/bin` that is not on PATH for the unit.

## My presets disappeared

They live in `~/.local/share/thermal-printer/presets.json`, which nothing in
the install or uninstall touches. If the file is there, the server is probably
reading a different data directory: check `THERMAL_DATA_DIR` in the unit.
