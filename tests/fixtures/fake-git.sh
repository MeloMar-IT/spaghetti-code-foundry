#!/bin/sh
# Stand-in for git in a step that signs in with a stored token: the https address $FAKE_GIT_URL is the local remote
# $FAKE_GH_REMOTE. It logs the GIT_ALLOW_PROTOCOL it was started with to $FAKE_GIT_LOG, then runs the real git ($FAKE_GIT_REAL),
# which may use the file protocol for that one rewrite.
# The server's own git calls (the run diff) run with a clean environment: no $FAKE_*; then use the next git on PATH.
if [ -z "$FAKE_GIT_REAL" ]; then
  here=$(dirname "$0")
  PATH=$(printf %s "$PATH" | tr ':' '\n' | grep -vxF "$here" | paste -sd: -)
  FAKE_GIT_REAL=$(command -v git)
fi
echo "allow=$GIT_ALLOW_PROTOCOL" >> "${FAKE_GIT_LOG:-/dev/null}"
# $FAKE_GIT_URL may hold several addresses, separated by spaces.
for u in $FAKE_GIT_URL; do set -- -c "url.$FAKE_GH_REMOTE.insteadOf=$u" "$@"; done
GIT_ALLOW_PROTOCOL=file exec "$FAKE_GIT_REAL" "$@"
