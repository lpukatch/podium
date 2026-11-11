#!/bin/sh
# Installs the mise release pinned by MISE_VERSION into ~/.local/bin and makes
# it visible to later steps. A plain download rather than jdx/mise-action: the
# runner resolves `uses:` through the forge's action mirror, which does not
# carry that action.
#
# The binary is verified against the release's own SHASUMS256.txt -- the same
# file mise-action checks (minisign-signed upstream). That pins the download's
# integrity, not the release itself: there is deliberately no hand-pinned
# hash, because renovate bumps MISE_VERSION alone and nothing here is
# maintained alongside a bump.
set -eu
: "${MISE_VERSION:?MISE_VERSION not set}"

base="https://github.com/jdx/mise/releases/download/v${MISE_VERSION}"
dir=$(mktemp -d)
curl -fsSL --retry 2 "$base/mise-v${MISE_VERSION}-linux-x64" -o "$dir/mise"
curl -fsSL --retry 2 "$base/SHASUMS256.txt" -o "$dir/SHASUMS256.txt"

# Match exactly one whole line (the upstream file prefixes entry names with
# ./, tolerated here in case a future release drops it), so extra entries in
# the checksum file cannot vouch for anything but this asset.
if ! grep -Ex "$(sha256sum "$dir/mise" | cut -d' ' -f1)  (\./)?mise-v${MISE_VERSION}-linux-x64" \
    "$dir/SHASUMS256.txt" >/dev/null; then
  echo 'mise checksum mismatch against the release SHASUMS256.txt; refusing to install' >&2
  exit 1
fi

mkdir -p "$HOME/.local/bin"
install -m 755 "$dir/mise" "$HOME/.local/bin/mise"
if [ -n "${GITHUB_PATH:-}" ]; then
  printf '%s\n' "$HOME/.local/bin" >> "$GITHUB_PATH"
fi
"$HOME/.local/bin/mise" --version
