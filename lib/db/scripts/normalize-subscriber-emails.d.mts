import type { PoolClient } from "pg";

export function normalizeSubscriberEmails(client: PoolClient): Promise<void>;