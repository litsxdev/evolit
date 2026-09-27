---
"evolit": patch
---

Make LitSX integration finalization single-flight per generation. Concurrent SSR requests now share one publication and one production module compile/import, invalidation queues one publication for the next generation, failed flights remain retryable, and disposal waits for active publication before integration cleanup.
