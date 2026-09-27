---
"evolit": patch
---

Keep a single project-resolved, server-conditioned `@litsx/urql` instance across setup and every request SSR phase, and deduplicate contextual LitSX peers in browser vendor groups. This prevents production SSR failures, vendor cycles, hydration refetches, and cross-request URQL cache leakage.
