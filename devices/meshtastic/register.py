"""Hook the HomeCircle modules into a Meshtastic checkout.

- Registers each module in src/modules/Modules.cpp, behind its own build
  flag, so tracker and home base builds come from the same checkout.
- Adds one line to src/gps/GPS.cpp that hands each character from the GPS
  module to the home base (hcGpsChar, a weak symbol: builds without the home
  base don't define it and nothing happens), so it can list the satellites
  it sees. Meshtastic keeps its own GPS parser private.

Running it again changes nothing.
"""
import os
import sys

MODULES = (("HOMECIRCLE", "HomeCircleModule"), ("HOMECIRCLE_HOMEBASE", "HomeBaseModule"), ("HOMECIRCLE_SOS", "HomeCircleSosModule"))
ANCHOR = "    adminModule = new AdminModule();"

path = sys.argv[1]
src = open(path).read()
for define, name in MODULES:
    if f"new {name}()" in src:
        continue
    if ANCHOR not in src:
        sys.exit(f"Modules.cpp has changed: register {name} by hand")
    src = src.replace('#include "configuration.h"\n', f'#include "configuration.h"\n#ifdef {define}\n#include "modules/{name}.h"\n#endif\n', 1)
    src = src.replace(ANCHOR, f"#ifdef {define}\n    new {name}();\n#endif\n{ANCHOR}", 1)
    print(f"registered {name} in Modules.cpp")
open(path, "w").write(src)

gps_path = os.path.join(os.path.dirname(os.path.dirname(path)), "gps", "GPS.cpp")
gps = open(gps_path).read()
if "hcGpsChar" not in gps:
    feed = "        isValid |= reader.encode(c);\n"
    if feed not in gps:
        sys.exit("GPS.cpp has changed: add the hcGpsChar hook by hand")
    gps = gps.replace(feed, feed + "        if (hcGpsChar)\n            hcGpsChar((char)c);\n", 1)
    first_include = gps.index("#include")
    gps = gps[:first_include] + "// HomeCircle: the home base reads the satellites in view (register.py).\nextern void hcGpsChar(char c) __attribute__((weak));\n" + gps[first_include:]
    open(gps_path, "w").write(gps)
    print("added the GPS hook in GPS.cpp")

# Every press of the button, counted: on a one-button tracker with HomeCircle
# (hcButtonPresses, weak: only HOMECIRCLE_SOS builds define it), 1 to 5
# presses each mean something (HomeCircleSos.cpp). Single, double and multi
# presses all report how many presses they were, so presses at a normal pace
# count as well as fast taps. For 2 or more the hook takes over from
# Meshtastic's own gestures (2: send a position, 3: GPS on or off, 4: mute),
# so "come pick me up" never turns the GPS off.
button_path = os.path.join(os.path.dirname(os.path.dirname(path)), "input", "ButtonThread.cpp")
button = open(button_path).read()
if "hcButtonPresses" not in button:
    # An earlier version of these hooks (hcButtonClicks): take it out first.
    for old in (
        "            if (hcButtonClicks) // HomeCircle (register.py)\n                hcButtonClicks(1);\n",
        "            if (hcButtonClicks) // HomeCircle (register.py)\n                hcButtonClicks(2);\n",
        "            if (hcButtonClicks) // HomeCircle (register.py)\n                hcButtonClicks(multipressClickCount);\n",
        "// HomeCircle: presses are counted for the SOS on a one-button tracker (register.py).\nextern void hcButtonClicks(int presses) __attribute__((weak));\n",
    ):
        button = button.replace(old, "")
    hooks = (
        ("            evt.inputEvent = _singlePress;\n", "            if (hcButtonPresses) // HomeCircle (register.py)\n                hcButtonPresses(1);\n"),
        ("            evt.inputEvent = _doublePress;\n", "            if (hcButtonPresses && hcButtonPresses(2)) // HomeCircle (register.py)\n                break;\n"),
        ("            switch (multipressClickCount) {\n", "            if (hcButtonPresses && hcButtonPresses(multipressClickCount)) // HomeCircle (register.py)\n                break;\n"),
    )
    for anchor, hook in hooks:
        if anchor not in button:
            sys.exit("ButtonThread.cpp has changed: add the hcButtonPresses hooks by hand")
        button = button.replace(anchor, hook + anchor, 1)
    first_include = button.index("#include")
    button = button[:first_include] + "// HomeCircle: presses are counted on a one-button tracker (register.py); true takes over the gesture.\nextern bool hcButtonPresses(int presses) __attribute__((weak));\n" + button[first_include:]
    open(button_path, "w").write(button)
    print("added the button hooks in ButtonThread.cpp")
