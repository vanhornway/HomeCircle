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
#
# HC_FW_VERSION (default: git describe) is the version the home base reports;
# HC_RELEASE_TAG (default: v<version>) is the GitHub release the files go on.
# For a home base, it also writes homebase-heltec-v4.bin and .json (version,
# size, SHA-256, link) to put on the GitHub release: the app reads the .json
# and has the home base update itself over Wi-Fi.
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

VERSION="${HC_FW_VERSION:-$(git -C "$HERE" describe --tags --always 2>/dev/null | sed 's/^v//' || echo dev)}"
export PLATFORMIO_BUILD_FLAGS="-DHC_FW_VERSION=\\\"$VERSION\\\""
pio run -d "$FW" -e "$ENV"
echo "Firmware $VERSION: $FW/.pio/build/$ENV/"

if [ "$ENV" = "heltec-v4-homebase" ]; then
  OUT="$FW/.pio/build/$ENV"
  # The app image (what's written at 0x10000), not the factory image with the bootloader.
  BIN="$(ls "$OUT"/firmware-*.bin | grep -v -e factory -e ota | head -1)"
  cp "$BIN" "$OUT/homebase-heltec-v4.bin"
  SHA="$(shasum -a 256 "$OUT/homebase-heltec-v4.bin" | cut -d' ' -f1)"
  SIZE="$(wc -c < "$OUT/homebase-heltec-v4.bin" | tr -d ' ')"
  # The release the two files go on (HC_RELEASE_TAG): its own tag, or an app release's.
  TAG_FOR_FILES="${HC_RELEASE_TAG:-v$VERSION}"
  cat > "$OUT/homebase-heltec-v4.json" <<EOF
{"version":"$VERSION","size":$SIZE,"sha256":"$SHA","url":"https://github.com/vanhornway/HomeCircle/releases/download/$TAG_FOR_FILES/homebase-heltec-v4.bin"}
EOF
  echo "Update files: $OUT/homebase-heltec-v4.bin and .json"
fi
