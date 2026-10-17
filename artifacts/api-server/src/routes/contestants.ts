import { and, desc, lt, or, sql } from "drizzle-orm";
import { Router, type IRouter } from "express";
import { GetAdminContestantsQueryParams, GetAdminContestantsResponse } from "@workspace/api-zod";
import { db, submissionsTable } from "@workspace/db";
import { isAdminAuthenticated } from "../lib/adminSession";

const router: IRouter = Router();

export function parseContestantsQuery(query: Record<string, unknown>) {
  // Reject repeated keys and noncanonical numerals before Zod's coercion.
  if (Object.keys(query).some((key) => !["search", "limit", "cursor"].includes(key))) return null;
  if (query.search !== undefined && typeof query.search !== "string") return null;
  if (query.limit !== undefined && (typeof query.limit !== "string" || !/^[1-9][0-9]*$/.test(query.limit))) return null;
  if (query.cursor !== undefined && (typeof query.cursor !== "string" || !/^[1-9][0-9]*$/.test(query.cursor))) return null;
  const parsed = GetAdminContestantsQueryParams.safeParse(query);
  if (!parsed.success) return null;
  const cursor = parsed.data.cursor === undefined ? undefined : Number(parsed.data.cursor);
  if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor > 2147483647)) return null;
  return { ...parsed.data, search: parsed.data.search?.trim() ?? "", cursor };
}

export function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

router.get("/admin/contestants", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "private, no-store");
  if (!isAdminAuthenticated(req)) {
    res.status(401).json({ error: "Admin authentication required" });
    return;
  }
  const query = parseContestantsQuery(req.query);
  if (!query) {
    res.status(400).json({ error: "Invalid contestant search or pagination" });
    return;
  }

  const pattern = `%${escapeLike(query.search)}%`;
  const searchCondition = query.search
    ? or(
        sql`${submissionsTable.ownerName} ILIKE ${pattern} ESCAPE '\\'`,
        sql`${submissionsTable.dogName} ILIKE ${pattern} ESCAPE '\\'`,
        sql`${submissionsTable.email} ILIKE ${pattern} ESCAPE '\\'`,
      )
    : undefined;
  const rows = await db.select({
    id: submissionsTable.id,
    ownerName: submissionsTable.ownerName,
    dogName: submissionsTable.dogName,
    email: submissionsTable.email,
    phone: submissionsTable.phone,
    submittedAt: submissionsTable.submittedAt,
    status: submissionsTable.status,
  }).from(submissionsTable)
    .where(and(query.cursor ? lt(submissionsTable.id, query.cursor) : undefined, searchCondition))
    .orderBy(desc(submissionsTable.id))
    .limit(query.limit + 1);
  const records = rows.slice(0, query.limit);
  res.json(GetAdminContestantsResponse.parse({
    records,
    nextCursor: rows.length > query.limit ? String(records[records.length - 1]!.id) : null,
  }));
});

export default router;