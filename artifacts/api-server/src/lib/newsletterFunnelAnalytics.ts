type AnalyticsCoverageAuditRecord = {
  coverageStartDate: string | null;
  reason: string;
};

const ANALYTICS_COVERAGE_AUDIT_TRAIL = [
  {
    coverageStartDate: "2026-06-29",
    reason: "Initial production deployment of newsletter funnel analytics.",
  },
] as const satisfies readonly AnalyticsCoverageAuditRecord[];
const DEFAULT_ANALYTICS_COVERAGE_START_DATE =
  ANALYTICS_COVERAGE_AUDIT_TRAIL.at(-1)?.coverageStartDate ?? null;
const REPORT_RANGE_START_DATE = "2026-06-01";
const REQUEST_COHORT_DAYS = 7;
const FOLLOW_UP_DAYS = 28;
const MIN_COMPARISON_REQUESTS = 30;
const Z_95 = 1.959963984540054;

type FunnelSource = "initial" | "replacement";
type ReportSection = "cohort_aligned" | "historical_aggregate_only";

type FunnelAggregateRow = {
  report_section: ReportSection;
  source: FunnelSource;
  requests: number | string;
  confirmations: number | string;
};

type CoverageRow = {
  cohort: string;
  coverage_status: "coverage_unavailable" | "missing_coverage" | "zero_requests" | "covered";
  requests: number | string;
};

type ClickHouseQuery = (query: string) => Promise<unknown[]>;

export type NewsletterFunnelReport = {
  reportAsOf: string;
  coverage: {
    startDate: string | null;
    status: "recorded" | "unavailable";
    auditTrail: readonly AnalyticsCoverageAuditRecord[];
    cohorts: Array<{
      cohort: string;
      coverageStatus: CoverageRow["coverage_status"];
      requests: number;
    }>;
    alerts: Array<{
      kind: "missing_events" | "coverage_regression";
      cohorts: string[];
    }>;
  };
  native: {
    rows: FunnelRow[];
    comparison: {
      result: string;
      liftPoints: number | null;
      liftCi95LowerPoints: number | null;
      liftCi95UpperPoints: number | null;
    };
  };
  historical: {
    rows: FunnelRow[];
  };
};

type FunnelRow = {
  source: FunnelSource;
  requests: number;
  confirmations: number;
  conversionRatePercent: number | null;
  ci95LowerPercent: number | null;
  ci95UpperPercent: number | null;
};

function getCoverageStartDate(): string | null {
  const configured = process.env["ANALYTICS_COVERAGE_START_DATE"];
  if (configured === "") return null;
  const coverageStartDate = configured ?? DEFAULT_ANALYTICS_COVERAGE_START_DATE;
  if (coverageStartDate === null) return null;

  const parsedDate = new Date(`${coverageStartDate}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(coverageStartDate) ||
    Number.isNaN(parsedDate.valueOf()) ||
    parsedDate.toISOString().slice(0, 10) !== coverageStartDate
  ) {
    throw new Error(
      "ANALYTICS_COVERAGE_START_DATE must be a valid UTC date in YYYY-MM-DD format",
    );
  }
  if (
    !ANALYTICS_COVERAGE_AUDIT_TRAIL.some(
      (record) => record.coverageStartDate === coverageStartDate,
    )
  ) {
    throw new Error(
      `ANALYTICS_COVERAGE_START_DATE ${coverageStartDate} has no matching entry in the newsletter analytics coverage audit trail`,
    );
  }
  return coverageStartDate;
}

function utcDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addUtcDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function reportWindow(now: Date): {
  reportAt: string;
  historicalCutoff: string;
} {
  const reportDate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return {
    reportAt: `${utcDateOnly(reportDate)} 00:00:00`,
    historicalCutoff: `${utcDateOnly(addUtcDays(reportDate, 1))} 00:00:00`,
  };
}

function reportAsOf(now: Date): string {
  return `${new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(now)} (UTC)`;
}

function aggregateQuery(reportAt: string, historicalCutoff: string): string {
  return `
WITH
  toDateTime('${reportAt}') AS report_at,
  toDateTime('${historicalCutoff}') AS historical_cutoff,
  INTERVAL ${REQUEST_COHORT_DAYS} DAY AS request_cohort_days,
  INTERVAL ${FOLLOW_UP_DAYS} DAY AS follow_up_days,
  request_counts AS (
    SELECT
      events.event_name AS event_name,
      properties.string_value AS cohort,
      count() AS requests
    FROM event_data AS properties
    INNER JOIN website_event AS events
      ON events.event_id = properties.event_id
    WHERE events.event_type = 2
      AND events.event_name IN (
        'subscription_confirmation_requested',
        'subscription_confirmation_replacement_requested'
      )
      AND properties.data_key = 'cohort'
      AND properties.data_type = 1
      AND match(properties.string_value, '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
      AND toDayOfWeek(toDate(properties.string_value)) = 1
      AND toDateTime(properties.string_value) + request_cohort_days + follow_up_days <= report_at
      AND NOT (
        events.url_path = '/__mockup'
        OR startsWith(events.url_path, '/__mockup/')
      )
    GROUP BY events.event_name, cohort
  ),
  eligible_cohorts AS (
    SELECT DISTINCT cohort
    FROM request_counts
  ),
  confirmation_sources AS (
    SELECT
      properties.event_id,
      anyIf(source.string_value, source.data_key = 'source') AS source,
      anyIf(properties.string_value, properties.data_key = 'cohort') AS cohort,
      events.created_at
    FROM event_data AS properties
    INNER JOIN website_event AS events
      ON events.event_id = properties.event_id
    LEFT JOIN event_data AS source
      ON source.event_id = properties.event_id
      AND source.data_key = 'source'
      AND source.data_type = 1
    WHERE events.event_type = 2
      AND events.event_name = 'subscription_confirmed'
      AND properties.data_key = 'cohort'
      AND properties.data_type = 1
      AND properties.string_value IN (SELECT cohort FROM eligible_cohorts)
      AND events.created_at >= toDateTime(properties.string_value)
      AND events.created_at < toDateTime(properties.string_value) + request_cohort_days + follow_up_days
      AND NOT (
        events.url_path = '/__mockup'
        OR startsWith(events.url_path, '/__mockup/')
      )
    GROUP BY properties.event_id, events.created_at
  ),
  confirmation_counts AS (
    SELECT cohort, source, count() AS confirmations
    FROM confirmation_sources
    WHERE source IN ('initial', 'replacement')
    GROUP BY cohort, source
  ),
  sources AS (
    SELECT arrayJoin(['initial', 'replacement']) AS source
  ),
  native_aggregates AS (
    SELECT
      sources.source AS source,
      coalesce(sum(request_counts.requests), 0) AS requests,
      coalesce(sum(confirmation_counts.confirmations), 0) AS confirmations
    FROM sources
    LEFT JOIN (
      SELECT
        if(
          request_counts.event_name = 'subscription_confirmation_requested',
          'initial',
          'replacement'
        ) AS source,
        request_counts.cohort AS cohort,
        request_counts.requests AS requests
      FROM request_counts
    ) AS request_counts USING source
    LEFT JOIN confirmation_counts USING source, cohort
    GROUP BY sources.source
  ),
  legacy_request_counts AS (
    SELECT
      if(
        events.event_name = 'subscription_confirmation_requested',
        'initial',
        'replacement'
      ) AS source,
      count() AS requests
    FROM website_event AS events
    LEFT JOIN event_data AS cohort
      ON cohort.event_id = events.event_id
      AND cohort.data_key = 'cohort'
      AND cohort.data_type = 1
    WHERE events.event_type = 2
      AND events.event_name IN (
        'subscription_confirmation_requested',
        'subscription_confirmation_replacement_requested'
      )
      AND events.created_at < historical_cutoff
      AND (
        toString(cohort.event_id) = ''
        OR toString(cohort.event_id) = '00000000-0000-0000-0000-000000000000'
      )
      AND NOT (
        events.url_path = '/__mockup'
        OR startsWith(events.url_path, '/__mockup/')
      )
    GROUP BY source
  ),
  legacy_confirmation_sources AS (
    SELECT
      properties.event_id,
      anyIf(
        properties.string_value,
        properties.data_key = 'source' AND properties.data_type = 1
      ) AS source,
      anyIf(
        properties.string_value,
        properties.data_key = 'history' AND properties.data_type = 1
      ) AS history,
      countIf(
        properties.data_key = 'cohort' AND properties.data_type = 1
      ) AS cohort_properties,
      events.created_at
    FROM event_data AS properties
    INNER JOIN website_event AS events
      ON events.event_id = properties.event_id
    WHERE events.event_type = 2
      AND events.event_name = 'subscription_confirmed'
      AND NOT (
        events.url_path = '/__mockup'
        OR startsWith(events.url_path, '/__mockup/')
      )
    GROUP BY properties.event_id, events.created_at
    HAVING cohort_properties = 0
      AND (
        history = 'legacy'
        OR (history = '' AND events.created_at < historical_cutoff)
      )
  ),
  legacy_confirmation_counts AS (
    SELECT source, count() AS confirmations
    FROM legacy_confirmation_sources
    WHERE source IN ('initial', 'replacement')
    GROUP BY source
  ),
  historical_aggregates AS (
    SELECT
      sources.source AS source,
      coalesce(legacy_request_counts.requests, 0) AS requests,
      coalesce(legacy_confirmation_counts.confirmations, 0) AS confirmations
    FROM sources
    LEFT JOIN legacy_request_counts USING source
    LEFT JOIN legacy_confirmation_counts USING source
  )
SELECT 'cohort_aligned' AS report_section, source, requests, confirmations
FROM native_aggregates
UNION ALL
SELECT 'historical_aggregate_only' AS report_section, source, requests, confirmations
FROM historical_aggregates
ORDER BY report_section, source
`;
}

function coverageQuery(
  reportAt: string,
  coverageStartDate: string | null,
): string {
  const coverageLiteral = coverageStartDate
    ? `toNullable(toDate('${coverageStartDate}'))`
    : "CAST(NULL, 'Nullable(Date)')";
  return `
WITH
  toDate('${REPORT_RANGE_START_DATE}') AS cohort_range_start,
  ${coverageLiteral} AS analytics_coverage_start,
  toDateTime('${reportAt}') AS report_at,
  INTERVAL ${REQUEST_COHORT_DAYS} DAY AS request_cohort_days,
  INTERVAL ${FOLLOW_UP_DAYS} DAY AS follow_up_days,
  native_request_events AS (
    SELECT
      events.created_at,
      toDate(properties.string_value) AS cohort
    FROM event_data AS properties
    INNER JOIN website_event AS events
      ON events.event_id = properties.event_id
    WHERE events.event_type = 2
      AND events.event_name IN (
        'subscription_confirmation_requested',
        'subscription_confirmation_replacement_requested'
      )
      AND properties.data_key = 'cohort'
      AND properties.data_type = 1
      AND match(properties.string_value, '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
      AND toDayOfWeek(toDate(properties.string_value)) = 1
      AND NOT (
        events.url_path = '/__mockup'
        OR startsWith(events.url_path, '/__mockup/')
      )
  ),
  coverage AS (
    SELECT
      analytics_coverage_start,
      toMonday(analytics_coverage_start) AS coverage_start_cohort
  ),
  request_counts AS (
    SELECT cohort, count() AS requests
    FROM native_request_events
    GROUP BY cohort
  ),
  cohort_calendar AS (
    SELECT addDays(
      toMonday(cohort_range_start),
      number * 7
    ) AS cohort
    FROM numbers(
      dateDiff(
        'week',
        toMonday(cohort_range_start),
        toMonday(toDate(report_at - request_cohort_days - follow_up_days))
      ) + 1
    )
  )
SELECT
  formatDateTime(cohort_calendar.cohort, '%F') AS cohort,
  multiIf(
    isNull(coverage.analytics_coverage_start),
      'coverage_unavailable',
    cohort_calendar.cohort < coverage.coverage_start_cohort,
      'missing_coverage',
    if(ifNull(request_counts.requests, 0) = 0, 'zero_requests', 'covered')
  ) AS coverage_status,
  ifNull(request_counts.requests, 0) AS requests
FROM cohort_calendar
CROSS JOIN coverage
LEFT JOIN request_counts USING cohort
ORDER BY cohort_calendar.cohort
`;
}

async function queryClickHouse(query: string): Promise<unknown[]> {
  const endpoint = process.env["CLICKHOUSE_URL"];
  if (!endpoint) {
    throw new Error("CLICKHOUSE_URL is required for the admin funnel report");
  }

  const headers: Record<string, string> = {
    "content-type": "text/plain; charset=utf-8",
    "x-clickhouse-format": "JSONEachRow",
  };
  const database = process.env["CLICKHOUSE_DATABASE"];
  const user = process.env["CLICKHOUSE_USER"];
  const password = process.env["CLICKHOUSE_PASSWORD"];
  if (database) headers["x-clickhouse-database"] = database;
  if (user) headers["x-clickhouse-user"] = user;
  if (password) headers["x-clickhouse-key"] = password;

  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: query,
  });
  if (!response.ok) {
    throw new Error(`Analytics provider returned HTTP ${response.status}`);
  }

  const body = await response.text();
  return body
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as unknown);
}

function integer(value: number | string, label: string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`Analytics provider returned an invalid ${label}`);
  }
  return result;
}

function conversionInterval(confirmations: number, requests: number): {
  rate: number;
  lower: number;
  upper: number;
} | null {
  if (requests === 0) return null;
  if (confirmations < 0 || confirmations > requests) {
    throw new Error("Analytics provider returned an invalid conversion aggregate");
  }
  const rate = confirmations / requests;
  const zSquared = Z_95 ** 2;
  const denominator = 1 + zSquared / requests;
  const center = (rate + zSquared / (2 * requests)) / denominator;
  const margin =
    (Z_95 *
      Math.sqrt(
        (rate * (1 - rate) + zSquared / (4 * requests)) / requests,
      )) /
    denominator;
  return {
    rate,
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

function toFunnelRow(row: FunnelAggregateRow): FunnelRow {
  const requests = integer(row.requests, "request count");
  const confirmations = integer(row.confirmations, "confirmation count");
  const interval = conversionInterval(confirmations, requests);
  return {
    source: row.source,
    requests,
    confirmations,
    conversionRatePercent: interval ? interval.rate * 100 : null,
    ci95LowerPercent: interval ? interval.lower * 100 : null,
    ci95UpperPercent: interval ? interval.upper * 100 : null,
  };
}

function nativeComparison(rows: FunnelRow[]) {
  const initial = rows.find((row) => row.source === "initial");
  const replacement = rows.find((row) => row.source === "replacement");
  if (!initial || !replacement) {
    throw new Error("Analytics provider did not return both native funnel sources");
  }
  const initialInterval = conversionInterval(initial.confirmations, initial.requests);
  const replacementInterval = conversionInterval(
    replacement.confirmations,
    replacement.requests,
  );
  if (!initialInterval || !replacementInterval) {
    return {
      result: "Inconclusive · sample too small",
      liftPoints: null,
      liftCi95LowerPoints: null,
      liftCi95UpperPoints: null,
    };
  }
  const difference = replacementInterval.rate - initialInterval.rate;
  const lower =
    difference -
    Math.sqrt(
      (replacementInterval.rate - replacementInterval.lower) ** 2 +
        (initialInterval.upper - initialInterval.rate) ** 2,
    );
  const upper =
    difference +
    Math.sqrt(
      (replacementInterval.upper - replacementInterval.rate) ** 2 +
        (initialInterval.rate - initialInterval.lower) ** 2,
    );
  const result =
    initial.requests < MIN_COMPARISON_REQUESTS ||
    replacement.requests < MIN_COMPARISON_REQUESTS
      ? "Inconclusive · sample too small"
      : lower > 0
        ? "Replacement outperforms"
        : upper < 0
          ? "Replacement underperforms"
          : "Inconclusive · difference includes zero";
  return {
    result,
    liftPoints: difference * 100,
    liftCi95LowerPoints: lower * 100,
    liftCi95UpperPoints: upper * 100,
  };
}

function coverageAlerts(
  cohorts: NewsletterFunnelReport["coverage"]["cohorts"],
) {
  const expectedCovered = [...cohorts]
    .sort((left, right) => left.cohort.localeCompare(right.cohort))
    .filter(
      (row) =>
        row.coverageStatus === "zero_requests" ||
        row.coverageStatus === "covered",
    );
  const missingEvents = expectedCovered
    .filter((row) => row.requests === 0)
    .map((row) => row.cohort);
  const regression: string[] = [];
  let observed = false;
  for (const row of expectedCovered) {
    if (row.requests > 0) observed = true;
    else if (observed) regression.push(row.cohort);
  }
  const alerts: NewsletterFunnelReport["coverage"]["alerts"] = [];
  if (missingEvents.length > 0) {
    alerts.push({ kind: "missing_events", cohorts: missingEvents });
  }
  if (regression.length > 0) {
    alerts.push({ kind: "coverage_regression", cohorts: regression });
  }
  return alerts;
}

export async function getNewsletterFunnelReport(
  now = new Date(),
  runQuery: ClickHouseQuery = queryClickHouse,
): Promise<NewsletterFunnelReport> {
  const coverageStartDate = getCoverageStartDate();
  const { reportAt, historicalCutoff } = reportWindow(now);
  const [aggregateRows, coverageRows] = await Promise.all([
    runQuery(aggregateQuery(reportAt, historicalCutoff)),
    runQuery(coverageQuery(reportAt, coverageStartDate)),
  ]);

  const aggregates = aggregateRows.map((row) => {
    if (!row || typeof row !== "object") {
      throw new Error("Analytics provider returned an invalid funnel row");
    }
    const value = row as Partial<FunnelAggregateRow>;
    if (
      (value.report_section !== "cohort_aligned" &&
        value.report_section !== "historical_aggregate_only") ||
      (value.source !== "initial" && value.source !== "replacement")
    ) {
      throw new Error("Analytics provider returned an invalid funnel section");
    }
    return value as FunnelAggregateRow;
  });
  const nativeRows = aggregates
    .filter((row) => row.report_section === "cohort_aligned")
    .map(toFunnelRow);
  const historicalRows = aggregates
    .filter((row) => row.report_section === "historical_aggregate_only")
    .map(toFunnelRow);
  if (nativeRows.length !== 2 || historicalRows.length !== 2) {
    throw new Error("Analytics provider did not return complete funnel sections");
  }

  const cohorts = coverageRows.map((row) => {
    if (!row || typeof row !== "object") {
      throw new Error("Analytics provider returned an invalid coverage row");
    }
    const value = row as Partial<CoverageRow>;
    if (
      typeof value.cohort !== "string" ||
      ![
        "coverage_unavailable",
        "missing_coverage",
        "zero_requests",
        "covered",
      ].includes(value.coverage_status ?? "")
    ) {
      throw new Error("Analytics provider returned an invalid coverage status");
    }
    return {
      cohort: value.cohort,
      coverageStatus: value.coverage_status as CoverageRow["coverage_status"],
      requests: integer(value.requests ?? -1, "coverage request count"),
    };
  });
  return {
    reportAsOf: reportAsOf(now),
    coverage: {
      startDate: coverageStartDate,
      status: coverageStartDate ? "recorded" : "unavailable",
      auditTrail: ANALYTICS_COVERAGE_AUDIT_TRAIL,
      cohorts,
      alerts: coverageAlerts(cohorts),
    },
    native: {
      rows: nativeRows,
      comparison: nativeComparison(nativeRows),
    },
    historical: {
      rows: historicalRows,
    },
  };
}