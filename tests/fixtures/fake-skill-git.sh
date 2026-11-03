#!/bin/sh
# Stand-in for git in the skill import tests. $STUB_MODE picks the behaviour:
#   redirect  runs the real git ($STUB_REAL); a fetch of $STUB_URL is rewritten to $STUB_REMOTE. When the sub-command
#             equals $STUB_ON (ls-tree, or cat-file with --batch) it first sends $STUB_SIGNAL to its parent.
#             With $STUB_SECRET_FILE set, fetch and ls-remote (also rewritten to $STUB_REMOTE) first write "$*" to $STUB_ARGS and
#             env to $STUB_ENV when set, then ask $GIT_ASKPASS for the user and the password, and exit 128 unless they are
#             x-access-token and the contents of $STUB_SECRET_FILE. $STUB_HANG then sleeps instead, and writes "<pid> <sleep pid>" to $STUB_PIDS.
#   hang      init makes the folder; fetch starts a background sleep, writes "<pid> <sleep pid> <GIT_DIR>" to
#             $STUB_PIDS, optionally fills $GIT_DIR with $STUB_FILL KiB, and waits.
#   ls-remote: fake prints a commit and HEAD, or by $STUB_HEAD: junk, two, flood, fail. hang starts a background sleep that
#             holds stdout open and writes "<pid> <sleep pid> <cwd>" to $STUB_PIDS.
#   fake      answers every call itself (see $STUB_INIT, $STUB_TYPE, $STUB_LIST, $STUB_READ).
# No sleep is longer than 20 s. Every call appends its pid to "$STUB_PIDS.all".
# The variables do not start with GIT_: the import strips those from the environment.
[ -n "$STUB_PIDS" ] && echo $$ >> "$STUB_PIDS.all"

sub=""
skip=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  if [ "$a" = "-c" ]; then skip=1; continue; fi
  sub=$a
  break
done
batch=0
case " $* " in *" --batch "*) batch=1 ;; esac

fill() {
  [ -n "$STUB_FILL" ] && head -c $((STUB_FILL * 1024)) /dev/zero > "$GIT_DIR/big"
  return 0
}

case "$STUB_MODE" in
  redirect)
    trigger=""
    if [ "$sub" = ls-tree ]; then trigger=ls-tree; fi
    if [ "$sub" = cat-file ] && [ "$batch" = 1 ]; then trigger=cat-file; fi
    if [ -n "$STUB_ON" ] && [ "$STUB_ON" = "$trigger" ]; then kill -s "$STUB_SIGNAL" "$PPID"; fi
    if [ -n "$STUB_SECRET_FILE" ] && { [ "$sub" = fetch ] || [ "$sub" = ls-remote ]; }; then
      # a private source: git must ask $GIT_ASKPASS for x-access-token and the secret, as it does after a 401
      [ -n "$STUB_ARGS" ] && echo "$*" > "$STUB_ARGS"
      [ -n "$STUB_ENV" ] && env > "$STUB_ENV"
      [ -n "$GIT_ASKPASS" ] || exit 128
      # git runs GIT_ASKPASS through a shell (the value is a quoted shell word): the stub does the same
      u=$(sh -c "$GIT_ASKPASS \"\$1\"" askpass "Username for 'https://github.com': ") || exit 128
      p=$(sh -c "$GIT_ASKPASS \"\$1\"" askpass "Password for 'https://x-access-token@github.com': ") || exit 128
      [ "$u" = x-access-token ] && [ "$p" = "$(cat "$STUB_SECRET_FILE")" ] || exit 128
      if [ -n "$STUB_HANG" ]; then
        sleep 20 </dev/null >/dev/null 2>&1 &
        echo "$$ $!" > "$STUB_PIDS"
        wait
        exit 1
      fi
      GIT_ALLOW_PROTOCOL=file exec "$STUB_REAL" -c "url.$STUB_REMOTE.insteadOf=$STUB_URL" "$@"
    fi
    if [ "$sub" = fetch ]; then
      GIT_ALLOW_PROTOCOL=file exec "$STUB_REAL" -c "url.$STUB_REMOTE.insteadOf=$STUB_URL" "$@"
    fi
    exec "$STUB_REAL" "$@"
    ;;
  hang)
    case "$sub" in
      ls-remote)
        # keeps stdout (the pipe of the caller) open, as a stalled https helper would
        sleep 20 </dev/null 2>/dev/null &
        echo "$$ $! $PWD" > "$STUB_PIDS"
        wait
        exit 1
        ;;
      init) /bin/mkdir -p "$GIT_DIR"; exit 0 ;;
      fetch)
        sleep 20 </dev/null >/dev/null 2>&1 &
        echo "$$ $! $GIT_DIR" > "$STUB_PIDS"
        fill
        wait
        exit 1
        ;;
      *) exit 1 ;;
    esac
    ;;
  fake)
    case "$sub" in
      ls-remote)
        [ -n "$STUB_ARGS" ] && echo "$*" > "$STUB_ARGS"
        [ -n "$STUB_ENV" ] && env > "$STUB_ENV"
        case "$STUB_HEAD" in
          junk) echo garbage ;;
          two) printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tHEAD\nbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\tHEAD\n' ;;
          flood) head -c 65536 /dev/zero ;;
          fail) exit 128 ;;
          *) printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tHEAD\n' ;;
        esac
        exit 0
        ;;
      init)
        /bin/mkdir -p "$GIT_DIR"
        [ -n "$STUB_ARGS" ] && echo "$*" > "$STUB_ARGS"
        case "$STUB_INIT" in
          stall) exec sleep 20 ;;
          vanish) /bin/rm -f "$0" ;;
        esac
        exit 0
        ;;
      fetch)
        [ -n "$STUB_ENV" ] && env > "$STUB_ENV"
        fill
        exit 0
        ;;
      cat-file)
        if [ "$batch" = 1 ]; then
          case "$STUB_READ" in
            flood) head -c 1048576 /dev/zero; exit 0 ;;
            stall) exec sleep 20 ;;
            short)
              read -r id
              printf '%s blob 10\nabc' "$id"
              exit 0
              ;;
          esac
          exit 0
        fi
        [ "$STUB_TYPE" = stall ] && exec sleep 20
        echo commit
        exit 0
        ;;
      ls-tree)
        case "$STUB_LIST" in
          flood) head -c 9437184 /dev/zero; exit 0 ;;
          stall) exec sleep 20 ;;
          junk) printf '100644 blob aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa      3 nofile\0'; exit 0 ;;
        esac
        exit 0
        ;;
    esac
    exit 1
    ;;
esac
exit 1
