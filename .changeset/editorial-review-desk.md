---
"@workspace/web": patch
"@workspace/lib": patch
"@workspace/content-workflow": patch
---

Add the Slice 4 editorial review desk: an owner approves (or anyone with a
reason sends back / rejects) the latest version of a YouTube draft, binding
the exact content, profile, evidence and asset-bundle hashes. Thumbnails
upload through the existing quarantine/scanner path and a non-CLEAN or
expired asset blocks approval. Editorial decisions are append-only, audited,
and grant no release authority.
