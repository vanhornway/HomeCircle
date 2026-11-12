#!/bin/bash
# Build Meshtastic with HomeCircle: a tracker, or a home base.
#
#   devices/meshtastic/build.sh <meshtastic checkout dir> [env]
#
# Clones the pinned Meshtastic release into the directory if it isn't there,
# copies in the modules, the tracker library and the board settings, registers
# the modules, and builds. Envs (variant/platformio.ini):
#   heltec-wireless-tracker-homecircle  a tracker (the default)
#   heltec-v4-homebase                  the home base
# Flash the result with the Meshtastic web flasher or:
#   pio run -d <dir> -e <env> -t upload
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
FW="${1:?usage: build.sh <meshtastic checkout dir> [env]}"
ENV="${2:-heltec-wireless-tracker-homecircle}"
TAG="v2.7.26.54e0d8d" # the Meshtastic release these modules are written against

if [ ! -d "$FW/.git" ]; then
  git clone --depth 1 --branch "$TAG" --recurse-submodules --shallow-submodules https://github.com/meshtastic/firmware.git "$FW"
fi

mkdir -p "$FW/src/modules/homecircle" "$FW/variants/esp32s3/homecircle"
cp "$HERE"/module/*.h "$HERE"/module/*.cpp "$FW/src/modules/"
cp "$HERE"/../tracker/lib/homecircle/src/hc_*.h "$HERE"/../tracker/lib/homecircle/src/hc_*.cpp "$FW/src/modules/homecircle/"
cp "$HERE/../tracker/src/firmware/roots.h" "$FW/src/modules/homecircle/"
cp "$HERE/variant/platformio.ini" "$FW/variants/esp32s3/homecircle/platformio.ini"

# Register the modules, once each.
python3 "$HERE/register.py" "$FW/src/modules/Modules.cpp"

pio run -d "$FW" -e "$ENV"
echo "Firmware: $FW/.pio/build/$ENV/"
