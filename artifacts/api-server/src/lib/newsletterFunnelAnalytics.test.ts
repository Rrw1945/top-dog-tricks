import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { GetNewsletterFunnelReportResponse } from "@workspace/api-zod";
import { getNewsletterFunnelReport } from "./newsletterFunnelAnalytics";

const aggregateRows = [
  {
    report_section: "cohort_aligned",
    source: "initial",
    requests: 100,
    confirmations: 40,
  },
  {
    report_section: "cohort_aligned",
    source: "replacement",
    requests: 100,
    confirmations: 60,
  },
  {
    report_section: "historical_aggregate_only",
    source: "initial",
    requests: 12,
    confirmations: 3,
  },
  {
    report_section: "historical_aggregate_only",
    source: "replacement",
    requests: 8,
    confirmations: 2,
  },
];

async function withCoverageMarker<T>(
  marker: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const previous = process.env["ANALYTICS_COVERAGE_START_DATE"];
  if (marker === undefined) {
    delete process.env["ANALYTICS_COVERAGE_START_DATE"];
  } else {
    process.env["ANALYTICS_COVERAGE_START_DATE"] = marker;
  }
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env["ANALYTICS_COVERAGE_START_DATE"];
    } else {
      process.env["ANALYTICS_COVERAGE_START_DATE"] = previous;
    }
  }
}

type CoverageAuditRecord = {
  coverageStartDate: string | null;
  reason: string;
};

const COVERAGE_PRIVACY_IDENTIFIER =
  /\b(?:session(?:_id)?|subscriber(?:_id)?|email(?:_address)?|token|event(?:_id)?|url_query|identifier)\b|[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;

function validateCoverageAuditTrail(
  source: string,
  records: readonly CoverageAuditRecord[],
): string | null {
  assert.ok(
    records.length > 0,
    `Analytics coverage audit drift: ${source} has no audit records; add the deployment history before relying on the active marker.`,
  );

  let previousDate: string | null = null;
  let unavailableMarkerSeen = false;
  for (const [index, record] of records.entries()) {
    if (record.coverageStartDate === null) {
      assert.equal(
        index,
        records.length - 1,
        `Analytics coverage audit drift: ${source} record ${index + 1} has an unavailable marker before a newer record.`,
      );
      unavailableMarkerSeen = true;
    } else {
      assert.match(
        record.coverageStartDate,
        /^\d{4}-\d{2}-\d{2}$/,
        `Analytics coverage audit drift: ${source} record ${index + 1} must use a UTC YYYY-MM-DD date.`,
      );
      const parsed = new Date(`${record.coverageStartDate}T00:00:00.000Z`);
      assert.ok(
        !Number.isNaN(parsed.getTime()) &&
          parsed.toISOString().slice(0, 10) === record.coverageStartDate,
        `Analytics coverage audit drift: ${source} record ${index + 1} has an invalid UTC calendar date (${record.coverageStartDate}).`,
      );
      assert.equal(
        unavailableMarkerSeen,
        false,
        `Analytics coverage audit drift: ${source} has a dated record after its unavailable marker.`,
      );
      if (previousDate !== null) {
        assert.ok(
          previousDate < record.coverageStartDate,
          `Analytics coverage audit drift: ${source} records must be strictly ordered by UTC date; record ${index + 1} is not newer than the prior record.`,
        );
      }
      previousDate = record.coverageStartDate;
    }
    assert.doesNotMatch(
      `${record.coverageStartDate ?? ""} ${record.reason}`,
      COVERAGE_PRIVACY_IDENTIFIER,
      `Analytics coverage audit drift: ${source} record ${index + 1} contains a privacy-sensitive identifier.`,
    );
  }

  return records.at(-1)?.coverageStartDate ?? null;
}

function parseFrontendCoverageAuditTrail(
  frontendSource: string,
): CoverageAuditRecord[] {
  const trailDeclaration = frontendSource.match(
    /export const ANALYTICS_COVERAGE_AUDIT_TRAIL = \[([\s\S]*?)\] as const satisfies readonly AnalyticsCoverageAuditRecord\[\];/,
  );
  assert.ok(
    trailDeclaration,
    "Analytics coverage audit drift: could not find the frontend coverage audit declaration; keep its exported name and record shape discoverable.",
  );

  const recordMatches = Array.from(
    trailDeclaration[1].matchAll(
      /\{\s*coverageStartDate:\s*(null|'((?:\\.|[^'\\])*)')\s*,\s*reason:\s*'((?:\\.|[^'\\])*)'\s*,?\s*\}/g,
    ),
  );
  const recordCount = (trailDeclaration[1].match(/\{/g) ?? []).length;
  assert.equal(
    recordMatches.length,
    recordCount,
    "Analytics coverage audit drift: frontend audit records must use the coverageStartDate and reason fields with string literals.",
  );

  return recordMatches.map(([, dateLiteral, dateValue, reasonValue]) => ({
    coverageStartDate:
      dateLiteral === "null" ? null : dateValue.replace(/\\(['\\])/g, "$1"),
    reason: reasonValue.replace(/\\(['\\])/g, "$1"),
  }));
}

function parseDocumentCoverageDate(
  value: string,
  source: string,
): string | null {
  if (value.toLowerCase() === "unavailable") return null;

  const parsed = new Date(`${value} UTC`);
  assert.ok(
    !Number.isNaN(parsed.getTime()) &&
      new Intl.DateTimeFormat("en-US", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }).format(parsed) === value,
    `Analytics coverage audit drift: ${source} date "${value}" must be a valid UTC calendar date such as "June 29, 2026".`,
  );
  return parsed.toISOString().slice(0, 10);
}

test("maps live analytics into separate aggregate-only funnel sections", async () => {
  const queries: string[] = [];
  const report = await withCoverageMarker(undefined, () =>
    getNewsletterFunnelReport(
      new Date("2026-09-10T12:00:00Z"),
      async (query) => {
        queries.push(query);
        if (query.includes("coverage_start_cohort")) {
          return [
            {
              cohort: "2026-06-01",
              coverage_status: "missing_coverage",
              requests: 0,
            },
            {
              cohort: "2026-06-22",
              coverage_status: "coverage_unavailable",
              requests: 0,
            },
            {
              cohort: "2026-07-27",
              coverage_status: "covered",
              requests: 100,
            },
          ];
        }
        return aggregateRows;
      },
    ),
  );

  assert.equal(report.reportAsOf, "September 10, 2026 (UTC)");
  assert.deepEqual(report.coverage.auditTrail, [
    {
      coverageStartDate: "2026-06-29",
      reason: "Initial production deployment of newsletter funnel analytics.",
    },
  ]);
  assert.deepEqual(
    report.coverage.cohorts.map(({ cohort, coverageStatus }) => ({
      cohort,
      coverageStatus,
    })),
    [
      { cohort: "2026-06-01", coverageStatus: "missing_coverage" },
      { cohort: "2026-06-22", coverageStatus: "coverage_unavailable" },
      { cohort: "2026-07-27", coverageStatus: "covered" },
    ],
  );
  assert.deepEqual(report.coverage.alerts, []);
  assert.equal(report.native.rows[0]?.requests, 100);
  assert.ok(Math.abs((report.native.comparison.liftPoints ?? 0) - 20) < 1e-9);
  assert.equal(report.historical.rows[0]?.conversionRatePercent, 25);
  assert.equal(report.historical.rows[0]?.ci95LowerPercent !== null, true);
  assert.equal(report.historical.rows[0]?.ci95UpperPercent !== null, true);
  assert.equal(report.native.comparison.result, "Replacement outperforms");
  assert.deepEqual(
    report.historical.rows.map((row) => row.source),
    ["initial", "replacement"],
  );
  assert.equal(
    JSON.stringify(report).match(
      /\b(session_id|subscriber_id|email|token|url_query|subscriber_email)\b/i,
    ),
    null,
  );
  assert.equal(queries.length, 2);
  assert.equal(
    queries.every(
      (query) =>
        !/\b(session_id|subscriber_id|email|token|url_query|subscriber_email)\b/i.test(
          query,
        ),
    ),
    true,
  );
});

test("rejects malformed coverage marker dates before querying analytics", async () => {
  await withCoverageMarker("2026-02-30", async () => {
    let queryCount = 0;
    await assert.rejects(
      getNewsletterFunnelReport(new Date("2026-09-10T12:00:00Z"), async () => {
        queryCount += 1;
        return [];
      }),
      /ANALYTICS_COVERAGE_START_DATE must be a valid UTC date in YYYY-MM-DD format/,
    );
    assert.equal(queryCount, 0);
  });
});

test("rejects unrecorded coverage marker overrides before querying analytics", async () => {
  await withCoverageMarker("2026-06-30", async () => {
    let queryCount = 0;
    await assert.rejects(
      getNewsletterFunnelReport(new Date("2026-09-10T12:00:00Z"), async () => {
        queryCount += 1;
        return [];
      }),
      /ANALYTICS_COVERAGE_START_DATE 2026-06-30 has no matching entry in the newsletter analytics coverage audit trail/,
    );
    assert.equal(queryCount, 0);
  });
});

test("accepts a coverage marker recorded in the audit trail", async () => {
  let coverageSql = "";
  const report = await withCoverageMarker("2026-06-29", () =>
    getNewsletterFunnelReport(
      new Date("2026-09-10T12:00:00Z"),
      async (query) => {
        if (query.includes("coverage_start_cohort")) {
          coverageSql = query;
          return [];
        }
        return aggregateRows;
      },
    ),
  );
  assert.equal(report.coverage.startDate, "2026-06-29");
  assert.equal(report.coverage.status, "recorded");
  assert.match(coverageSql, /toNullable\(toDate\('2026-06-29'\)\)/);
});

test("an explicitly empty coverage marker keeps coverage unavailable", async () => {
  let coverageSql = "";
  const report = await withCoverageMarker("", () =>
    getNewsletterFunnelReport(
      new Date("2026-09-10T12:00:00Z"),
      async (query) => {
        if (query.includes("coverage_start_cohort")) {
          coverageSql = query;
          return [
            {
              cohort: "2026-06-01",
              coverage_status: "coverage_unavailable",
              requests: 0,
            },
          ];
        }
        return aggregateRows;
      },
    ),
  );
  assert.equal(report.coverage.startDate, null);
  assert.equal(report.coverage.status, "unavailable");
  assert.match(coverageSql, /CAST\(NULL, 'Nullable\(Date\)'\)/);
  assert.deepEqual(report.coverage.auditTrail, [
    {
      coverageStartDate: "2026-06-29",
      reason: "Initial production deployment of newsletter funnel analytics.",
    },
  ]);
});

test("keeps the coverage marker and audit trail aligned across frontend, API, generated response, and docs", async () => {
  const projectRoot = resolve(process.cwd(), "..");
  const frontendSource = readFileSync(
    resolve(projectRoot, "top-dog-tricks/src/lib/analytics.ts"),
    "utf8",
  );
  const frontendAuditTrail = parseFrontendCoverageAuditTrail(frontendSource);
  const activeMarkerDeclaration = frontendSource
    .match(
      /export const ANALYTICS_COVERAGE_START_DATE: string \| null =([^;]+);/,
    )?.[1]
    .trim();
  assert.equal(
    activeMarkerDeclaration,
    "ANALYTICS_COVERAGE_AUDIT_TRAIL.at(-1)?.coverageStartDate ?? null",
    "Analytics coverage audit drift: the frontend active marker must derive from the newest audit record.",
  );

  const report = await withCoverageMarker(undefined, () =>
    getNewsletterFunnelReport(
      new Date("2026-09-10T12:00:00Z"),
      async (query) =>
        query.includes("coverage_start_cohort") ? [] : aggregateRows,
    ),
  );

  const frontendActiveMarker = validateCoverageAuditTrail(
    "frontend configuration",
    frontendAuditTrail,
  );
  assert.equal(
    frontendActiveMarker,
    frontendAuditTrail.at(-1)?.coverageStartDate ?? null,
    "Analytics coverage audit drift: the frontend active marker must be the newest frontend audit record.",
  );

  const apiActiveMarker = validateCoverageAuditTrail(
    "API response",
    report.coverage.auditTrail,
  );
  assert.deepEqual(
    report.coverage.auditTrail,
    frontendAuditTrail,
    "Analytics coverage audit drift: API audit records differ from the frontend configuration.",
  );
  assert.equal(
    report.coverage.startDate,
    frontendActiveMarker,
    "Analytics coverage audit drift: the API active marker differs from the newest frontend audit record.",
  );
  assert.equal(
    apiActiveMarker,
    report.coverage.startDate,
    "Analytics coverage audit drift: the newest API audit record differs from the API active marker.",
  );

  const parsedResponse = GetNewsletterFunnelReportResponse.parse(report);
  assert.deepEqual(
    parsedResponse.coverage.auditTrail,
    report.coverage.auditTrail,
    "Analytics coverage audit drift: generated API response shape does not preserve the audit trail.",
  );
  assert.equal(
    parsedResponse.coverage.startDate,
    report.coverage.startDate,
    "Analytics coverage audit drift: generated API response shape does not preserve the active marker.",
  );

  const funnelDocumentation = readFileSync(
    resolve(
      projectRoot,
      "top-dog-tricks/docs/newsletter-confirmation-funnel.md",
    ),
    "utf8",
  );
  const auditSection = funnelDocumentation.match(
    /### Analytics coverage marker audit trail([\s\S]*?)(?=\n### |\s*$)/,
  )?.[1];
  assert.ok(
    auditSection,
    "Analytics coverage audit drift: documentation is missing the coverage marker audit trail section.",
  );
  const documentedTrail = Array.from(
    auditSection.matchAll(
      /^\| (Unavailable|[A-Z][a-z]+ \d{1,2}, \d{4}) \| ([^|\r\n]+) \|$/gm,
    ),
    ([, date, reason]) => ({
      coverageStartDate: parseDocumentCoverageDate(date, "documentation"),
      reason: reason.trim(),
    }),
  );
  const documentedActiveMarkerText = funnelDocumentation.match(
    /operator-recorded analytics coverage start is \*\*([^*]+) \(UTC\)\*\*/i,
  )?.[1];
  assert.ok(
    documentedActiveMarkerText,
    "Analytics coverage audit drift: documentation is missing its active coverage marker in the report summary.",
  );
  const documentedActiveMarker = parseDocumentCoverageDate(
    documentedActiveMarkerText,
    "documentation summary",
  );
  const documentedNewestMarker = validateCoverageAuditTrail(
    "documentation",
    documentedTrail,
  );

  assert.deepEqual(
    documentedTrail,
    frontendAuditTrail,
    "Analytics coverage audit drift: documentation audit records differ from the frontend configuration; update the table to match.",
  );
  assert.equal(
    documentedActiveMarker,
    frontendActiveMarker,
    "Analytics coverage audit drift: documentation summary marker differs from the frontend active marker.",
  );
  assert.equal(
    documentedNewestMarker,
    documentedActiveMarker,
    "Analytics coverage audit drift: the newest documented audit record must be the active marker.",
  );
});
