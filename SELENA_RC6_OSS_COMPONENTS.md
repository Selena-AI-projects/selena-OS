# Selena RC6 OSS component registry

| Component | Repository/source | License | Selena adaptation | Version policy |
|---|---|---|---|---|
| Public Readiness heuristics | [`zubair-trabzada/geo-seo-claude`](https://github.com/zubair-trabzada/geo-seo-claude/tree/ed280a860bca84b22f0199ee2d8776ce0c55bd56), pinned commit `ed280a860bca84b22f0199ee2d8776ce0c55bd56` (`main`, no upstream release tag returned) | MIT; notice reproduced below | Readiness scoring, crawler and citability rules are normalized into Selena contracts; no Claude agent runtime is copied or vendored | Every adapted rule stores Selena `source_engine`, `source_version`, `rule_id` and `rule_version`; this registry pins the upstream reference used for review |

The current implementation uses evidence-safe, deterministic heuristics only.
It does not claim that citability or `llms.txt` is a proven ranking factor.
`llms.txt` remains diagnostic-only with weight `0`. No production write or
auto-apply capability is included.

The pinned repository and license were checked on 2026-08-16. The upstream
repository did not return a release tag, so the immutable commit is the
version anchor. This registry is an implementation record, not an assertion
that upstream code is already vendored.

## Upstream MIT notice

The following notice is retained for the adapted reference algorithms:

```text
MIT License

Copyright (c) 2026 Zubair Trabzada

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Central Memory provenance for the upstream repository and license source:

- repository source record: `a787589f-301b-4b0d-b025-0c9b1aa749cd`
- repository source version: `e0cf140e-e125-499f-a04d-4a81bb476a33`
- repository content hash: `3a978cb0fcdc7f018b7c13c8aa0237fff1cafc77b42556554e8af0a0f3dccb87`
- license source record: `5d6c8686-87ce-4a38-9268-b36983bc2287`
- license source version: `ab246df9-c6f2-408f-b146-8306777a9857`
- license content hash: `495df4d6707a37a483fb78a959e506e33e1bd4a9780889c5de9c84fed107249c`
