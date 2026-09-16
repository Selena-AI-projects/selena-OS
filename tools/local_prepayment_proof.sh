#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
proof_dir="$(mktemp -d /tmp/local-prepayment-proof.XXXXXX)"
cleanup() { pg_ctl -D "$proof_dir/data" -m fast -w stop >/dev/null 2>&1 || true; }
trap cleanup EXIT
initdb -D "$proof_dir/data" -U local_proof_admin -A trust --no-locale >/dev/null
pg_ctl -D "$proof_dir/data" -l "$proof_dir/postgres.log" -o "-h 127.0.0.1 -p 56648 -k $proof_dir" -w start >/dev/null
createdb -h 127.0.0.1 -p 56648 -U local_proof_admin local_prepayment_proof
cd "$root/apps/web"
LOCAL_PREPAYMENT_PROOF_URL=postgresql://local_proof_admin@127.0.0.1:56648/local_prepayment_proof node --import tsx scripts/local-prepayment-proof.ts
createdb -h 127.0.0.1 -p 56648 -U local_proof_admin local_prepayment_migrations
LOCAL_PREPAYMENT_PROOF_URL=postgresql://local_proof_admin@127.0.0.1:56648/local_prepayment_proof node --import tsx scripts/local-prepayment-migrations-proof.ts
