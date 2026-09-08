---
"@workspace/web": patch
---

Add the Provider budgets screen: the owner sets per-provider call and cost
ceilings (day or month window) and sees what the current window has already
committed — the same numbers the durable reserve decides with. Budgets are
append-only; members see them read-only. No provider is called on this path.
