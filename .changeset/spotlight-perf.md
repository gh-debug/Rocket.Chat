---
'@rocket.chat/meteor': patch
'@rocket.chat/models': patch
---

Improves `/spotlight` (and the legacy `spotlight` method) latency without changing results: user and room searches now run concurrently, room queries read from secondary replicas, and the connected-users aggregation projects away unused fields before its `$unwind`/`$group` stages so far less data flows through the pipeline.
