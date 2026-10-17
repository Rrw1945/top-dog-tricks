import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import type { Request, Response } from "express";
import { ListSubmissionsQueryParams, ListSubmissionsResponse } from "@workspace/api-zod";
import { db, submissionsTable } from "@workspace/db";
import { isAdminAuthenticated } from "../lib/adminSession";

export function parseReviewQueueQuery(query: Record<string, unknown>) {
  if (Object.keys(query).some((key) => !["search", "status", "limit", "cursor", "category"].includes(key))) return null;
  for (const key of ["search", "status", "limit", "cursor", "category"]) {
    if (query[key] !== undefined && typeof query[key] !== "string") return null;
  }
  for (const key of ["limit", "cursor"]) {
    if (query[key] !== undefined && !/^[1-9][0-9]*$/.test(query[key] as string)) return null;
  }
  const parsed = ListSubmissionsQueryParams.safeParse(query);
  return parsed.success ? { ...parsed.data, search: parsed.data.search?.trim() ?? "" } : null;
}

export async function listReviewQueue(req: Request, res: Response): Promise<void> {
  res.setHeader("Cache-Control", "private, no-store");
  if (!isAdminAuthenticated(req)) {
    res.status(401).json({ error: "Admin authentication required" });
    return;
  }
  const query = parseReviewQueueQuery(req.query);
  if (!query) {
    res.status(400).json({ error: "Invalid review queue search or pagination" });
    return;
  }
  if (query.search && Array.from(query.search).length < 3) {
    res.status(400).json({ error: "Review searches need at least 3 characters to keep large archives responsive. Enter more characters or clear the search to browse." });
    return;
  }
  const pattern = `%${query.search.replace(/[\\%_]/g, "\\$&")}%`;
  const rows = await db.select({
    id: submissionsTable.id,
    dogName: submissionsTable.dogName,
    ownerName: submissionsTable.ownerName,
    trickName: submissionsTable.trickName,
    status: submissionsTable.status,
  }).from(submissionsTable)
    .where(and(
      query.cursor === undefined ? undefined : lt(submissionsTable.id, query.cursor),
      query.status ? eq(submissionsTable.status, query.status) : undefined,
      query.category ? eq(submissionsTable.category, query.category) : undefined,
      query.search ? or(
        sql`${submissionsTable.dogName} ILIKE ${pattern} ESCAPE '\\'`,
        sql`${submissionsTable.ownerName} ILIKE ${pattern} ESCAPE '\\'`,
        sql`${submissionsTable.trickName} ILIKE ${pattern} ESCAPE '\\'`,
      ) : undefined,
    ))
    // Immutable IDs prevent edits and status changes from shifting later pages.
    .orderBy(desc(submissionsTable.id))
    .limit(query.limit + 1);
  const records = rows.slice(0, query.limit);
  res.json(ListSubmissionsResponse.parse({
    records,
    nextCursor: rows.length > query.limit ? records[records.length - 1]!.id : null,
  }));
}
