---
"@workspace/lib": patch
"@workspace/web": patch
---

The website review now checks whether the site lets AI answer engines in: it reads robots.txt for the crawlers behind ChatGPT Search, Perplexity, Claude, Google and Bing, flags noindex/nosnippet pages, asks the owner to confirm a blocked training crawler rather than calling it a defect, names every recommendation by what to do instead of a rule id, and sorts the cabinet's priority actions by urgency.
