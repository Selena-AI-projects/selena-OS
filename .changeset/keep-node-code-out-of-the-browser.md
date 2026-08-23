---
"@workspace/web": patch
"@workspace/lib": patch
---

Fix the application failing to start in the browser: the Postgres driver and Node's HTTP client were shipped in the client bundle, so pages loaded but nothing was interactive.
