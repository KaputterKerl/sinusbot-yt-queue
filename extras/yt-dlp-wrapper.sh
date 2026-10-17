#!/bin/bash
# Wrapper around yt-dlp used by SinusBot (YoutubeDLPath).
# - Uses /opt/sinusbot/data/cookies.txt (Netscape format) if present.
#   Copied to a temp file because yt-dlp rewrites the cookie jar.
# - YTDLP_EXTRA_ARGS: additional arguments, e.g. "--extractor-args youtube:player_client=web,mweb"

# bot user has no writable HOME: keep the cache (signature functions) in /tmp
export XDG_CACHE_HOME="${XDG_CACHE_HOME:-/tmp/yt-dlp-cache}"

ARGS=()
COOKIES="/opt/sinusbot/data/cookies.txt"
if [ -f "$COOKIES" ]; then
  TMP="$(mktemp)"
  trap 'rm -f "$TMP"' EXIT
  cp "$COOKIES" "$TMP"
  ARGS+=(--cookies "$TMP")
fi

if [ -n "$YTDLP_EXTRA_ARGS" ]; then
  # shellcheck disable=SC2206
  ARGS+=($YTDLP_EXTRA_ARGS)
fi

# no exec: trap must run to clean up the temp file
/usr/local/bin/yt-dlp "${ARGS[@]}" "$@"
