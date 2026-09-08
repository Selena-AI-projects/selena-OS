---
"@workspace/lib": patch
---

Give the Video Radar research adapter a real YouTube Data API v3 dispatcher. The API key is read only inside the new dispatcher module, one HTTP request counts as one external provider call, and every existing gate — env switches, call ceiling, credential flag, and the durable budget reservation — still fronts any live dispatch. The fixture research path is unchanged.
