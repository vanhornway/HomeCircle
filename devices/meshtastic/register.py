"""Register the HomeCircle modules in Meshtastic's src/modules/Modules.cpp.

Each is behind its own build flag, so a tracker build and a home base build
come from the same checkout. Running it again changes nothing.
"""
import sys

MODULES = (("HOMECIRCLE", "HomeCircleModule"), ("HOMECIRCLE_HOMEBASE", "HomeBaseModule"))
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
