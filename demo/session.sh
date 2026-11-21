#!/bin/sh
set -eu

root=$(CDPATH='' cd "$(dirname "$0")/.." && pwd -P)
node=$(node -p 'process.execPath')
scratch=$(mktemp -d)
scratch=$(cd "$scratch" && pwd -P)
trap 'rm -rf "$scratch"' EXIT
mkdir -p "$scratch/home/field-notes" "$scratch/agent"
cd "$scratch/home/field-notes"

printf '# Release notes\n\n- CSV export (preview)\n' > CHANGELOG.md
printf 'export CHANNEL=preview\n' > .envrc
printf '{"mode":"strict","network":"denied"}\n' > "$scratch/agent/mxc-sandbox.json"
printf '{"quietStartup":true,"theme":"dark"}\n' > "$scratch/agent/settings.json"

env -i HOME="$scratch/home" PATH="$PATH" \
    TERM="${TERM:-xterm-256color}" COLORTERM=truecolor LANG=en_US.UTF-8 \
    PI_CODING_AGENT_DIR="$scratch/agent" \
    "$node" "$root/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js" \
    --offline --no-approve --no-session --no-mcp --no-extensions --no-skills \
    --no-context-files --no-prompt-templates -e "$root" -e "$root/demo/model.ts" \
    --provider demo --model scripted "$@"

test "$(cat CHANGELOG.md)" = "$(printf '# Release notes\n\n- CSV export')"
test "$(cat .envrc)" = 'export CHANNEL=preview'
