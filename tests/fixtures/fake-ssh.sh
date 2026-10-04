#!/bin/sh
# Stand-in for ssh in a step that signs in with a deploy key. Logs the call, the agent socket and the size of the key file and
# of known_hosts to $FAKE_SSH_LOG. With $FAKE_SSH_FAIL set it prints that text to stderr and fails like ssh (255). Otherwise it
# serves the local remote $FAKE_GH_REMOTE for git-upload-pack and git-receive-pack, using the real git ($FAKE_GIT_REAL).
{
  echo "ssh $*"
  echo "agent=${SSH_AUTH_SOCK:-none}"
  echo "key=$(wc -c < "$SCF_SSH_KEY" 2>/dev/null | tr -d ' ')"
  echo "known_hosts=$(wc -c < "$SCF_KNOWN_HOSTS" 2>/dev/null | tr -d ' ')"
} >> "$FAKE_SSH_LOG"
if [ -n "$FAKE_SSH_FAIL" ]; then printf '%s\n' "$FAKE_SSH_FAIL" >&2; exit 255; fi
for last; do :; done
case "$last" in
  git-upload-pack*) exec "$FAKE_GIT_REAL" upload-pack "$FAKE_GH_REMOTE" ;;
  git-receive-pack*) exec "$FAKE_GIT_REAL" receive-pack "$FAKE_GH_REMOTE" ;;
esac
exit 1
