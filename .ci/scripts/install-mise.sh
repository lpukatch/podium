#!/bin/sh
# Installs the mise release pinned by MISE_VERSION into ~/.local/bin and makes
# it visible to later steps. A plain checksummed download rather than
# jdx/mise-action: the runner resolves `uses:` through the forge's action
# mirror, which does not carry that action.
#
# renovate bumps only MISE_VERSION -- update MISE_SHA256 alongside it (the
# tool-pins contract test keeps the pairing honest, and the checksum below
# hard-fails a wrong download the same way fetch_cliff used to for git-cliff).
set -eu
: "${MISE_VERSION:?MISE_VERSION not set}"
: "${MISE_SHA256:?MISE_SHA256 not set}"

dir=$(mktemp -d)
curl -fsSL --retry 2 \
  "https://github.com/jdx/mise/releases/download/v${MISE_VERSION}/mise-v${MISE_VERSION}-linux-x64" \
  -o "$dir/mise"
if ! printf '%s  %s\n' "$MISE_SHA256" "$dir/mise" | sha256sum -c --status -; then
  echo 'mise checksum mismatch; refusing to install' >&2
  exit 1
fi
mkdir -p "$HOME/.local/bin"
install -m 755 "$dir/mise" "$HOME/.local/bin/mise"
if [ -n "${GITHUB_PATH:-}" ]; then
  printf '%s\n' "$HOME/.local/bin" >> "$GITHUB_PATH"
fi
"$HOME/.local/bin/mise" --version
