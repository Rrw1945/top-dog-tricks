---
name: Welcome lease clock authority
description: The clock source and regression-test rule for recovering subscriber welcome email leases.
---

Welcome email lease eligibility must be evaluated with PostgreSQL's current timestamp, not an application-server clock. Recovery tests should anchor persisted timestamps to database time and pass deliberately fast or slow application times without sleeping.

**Why:** Application servers can disagree with the database or with one another; using an application clock can reclaim an active delivery too early or hide a lease that has already expired.

**How to apply:** Keep lease cutoffs and claim timestamps database-authoritative. When testing timing behavior, assert against persisted database timestamps and state transitions rather than elapsed wall-clock delays.