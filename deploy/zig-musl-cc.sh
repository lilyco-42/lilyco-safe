#!/usr/bin/env bash
args=()
for a in "$@"; do
  case "$a" in
    --target=x86_64-unknown-linux-musl) ;;
    *) args+=("$a") ;;
  esac
done
exec zig cc -target x86_64-linux-musl "${args[@]}"
