---
"@workspace/web": patch
"@workspace/lib": patch
"@workspace/worker": patch
---

Dashboard visibility queries read from a persistent hourly rollup instead of scanning every stored answer, cutting large-history load times by two orders of magnitude.
