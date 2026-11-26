#!/bin/sh
set -eu
mkdir -p dist/native
if [ "$(uname -s)" = Darwin ]; then
    ${CC:-cc} -O2 -Wall -Wextra -Werror native/status.c -o dist/native/status
    ${CC:-cc} -O2 -Wall -Wextra -Werror native/snapshot.c -o dist/native/snapshot
fi
