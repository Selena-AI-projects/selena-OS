#!/bin/sh

set -eu

# The scanner must never run with an empty or stale-on-first-boot signature
# database. A failed update leaves the service unavailable rather than marking
# an uploaded file as safe.
freshclam --config-file=/etc/clamav/freshclam.conf --stdout
clamd --config-file=/etc/clamav/clamd.conf &
clamd_pid="$!"

cleanup() {
	kill "$clamd_pid" 2>/dev/null || true
}

trap cleanup EXIT INT TERM

exec "$@"
