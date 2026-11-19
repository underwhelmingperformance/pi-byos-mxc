#!/bin/sh
set -eu
mkdir -p dist/native
${CC:-cc} -O2 -Wall -Wextra -Werror native/files.c -o dist/native/files
if [ "$(uname -s)" = Darwin ]; then
    ${CC:-cc} -O2 -Wall -Wextra -Werror native/status.c -o dist/native/status
fi
