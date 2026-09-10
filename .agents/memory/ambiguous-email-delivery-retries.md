---
name: Ambiguous email delivery retries
description: Reliability rule for retrying emails whose provider acceptance is uncertain.
---

When an email provider call may have been accepted before throwing, retain and reuse the same actionable token and provider idempotency identity on retry. Do not restore an older token and generate a new attempt. Finalize that retry identity only after definite provider success, while retaining the original cooldown timestamp.

**Why:** An accepted-then-thrown request may already have delivered the first message. Rotating on retry makes that delivered link invalid and can send conflicting messages; a new idempotency key cannot deduplicate the earlier acceptance.

**How to apply:** Persist a non-secret attempt identity, derive or otherwise recover the same link token, and retry with the original provider idempotency key until the attempt reaches a definite outcome. On success, conditionally close the matching attempt without extending its cooldown.