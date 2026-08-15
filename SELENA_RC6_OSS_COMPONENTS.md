# Selena RC6 OSS component registry

| Component | Repository/source | License | Selena adaptation | Version policy |
|---|---|---|---|---|
| Public Readiness heuristics | `geo-seo-claude` reference algorithms | MIT (notice required) | Readiness scoring, crawler and citability rules are normalized into Selena contracts; no Claude agent runtime is copied | Every adapted rule stores `source_engine`, `source_version`, `rule_id` and `rule_version` |

The current implementation uses evidence-safe, deterministic heuristics only.
It does not claim that citability or `llms.txt` is a proven ranking factor.
`llms.txt` remains diagnostic-only with weight `0`. No production write or
auto-apply capability is included.

Before commercial distribution, the exact upstream commit/tag and full MIT
notice must be recorded here and included in the distribution notices. This
registry is an implementation record, not an assertion that upstream code is
already vendored.
