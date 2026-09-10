# Newsletter confirmation recovery funnel

## Latest complete request-cohort view

Report as of **September 9, 2026 (UTC)**. The primary report uses
Monday-starting, seven-day UTC request cohorts. A cohort is published only
after its 28-day follow-up window closes, so the newest requests are
intentionally absent until their outcomes can be observed.

### Native cohort-aligned data

| Confirmation source | Requests | Completed confirmations | Conversion rate | 95% confidence interval |
| --- | ---: | ---: | ---: | ---: |
| Initial email | 0 | 0 | — | — |
| Replacement email | 0 | 0 | — | — |

No completed request cohorts contain newsletter funnel events in this
report. A conversion rate is not reported when its request denominator is
zero.

**Replacement vs. initial baseline: Inconclusive — sample too small.** Both
sources need at least 30 requests from completed cohorts before the comparison
is eligible for a directional conclusion.

Each row is a **request-cohort conversion rate**: confirmations carry the
fixed cohort marker of the request that created the active confirmation link.
The newsletter endpoints return that same server-authoritative marker in their
aggregate-only `cohort` response field, and the browser uses it for the request
event. The browser clock is never used to assign a request cohort.
Requests from the newest cohort, and confirmations whose cohort follow-up
window has not closed, are excluded rather than paired with a different
period.

### Historical aggregate-only backfill

| Confirmation source | Requests | Completed confirmations | Conversion rate | 95% confidence interval |
| --- | ---: | ---: | ---: | ---: |
| Initial email | 0 | 0 | — | — |
| Replacement email | 0 | 0 | — | — |

This section is a controlled aggregate backfill for events before the cohort
marker cutoff. It is not a cohort conversion rate, is not included in the
replacement-versus-initial comparison, and must never be joined to a
subscriber, email address, token, session, or other individual identity.
Historical links remain valid; a confirmation from one is reported here with
its source only. The two sections must stay visibly separate in any dashboard
or exported report.

## Cohort, cutoff, and follow-up rules

Use Monday-starting, seven-day UTC cohorts for both initial and replacement
requests. The server assigns the cohort at the request endpoint and returns it
to the browser; the token and request event therefore share one marker even
when a device clock is skewed or the request crosses a UTC week boundary. A
request cohort closes at the end of its seven-day request period,
then remains in follow-up for **28 complete days**. Only cohorts whose
follow-up end is at or before the report time are eligible.

The cohort marker is a calendar week only. It is not a session ID, subscriber
ID, email address, token, or other subscriber-level identifier.

The historical backfill uses the explicit cutoff
**September 10, 2026 00:00:00 UTC**, the start of the first full UTC day on
which cohort markers are expected after the rollout. Legacy request events are
eligible only when they are before that cutoff and have no cohort property. Legacy
confirmation events are eligible when they either have the explicit
`history=legacy` marker emitted for an older link or predate the cutoff and
have no cohort property. This allows existing aggregate history and later
clicks on still-valid old links to be counted without guessing which request
cohort a subscriber belonged to.

The cutoff is a reporting boundary, not a token-expiration rule. Do not move
an event into a native cohort after the fact, and do not use the legacy
aggregate rows as denominators for native cohort rates.

Continue reporting request counts and 95% confidence intervals beside every
rate. Even above the minimum sample, label the native comparison
**inconclusive** when the 95% confidence interval for the
replacement-minus-initial rate difference includes zero. Label it
**replacement outperforms** only when the entire interval is above zero, or
**replacement underperforms** only when the entire interval is below zero.

Rate intervals use the 95% Wilson score method, which behaves better than a
normal interval for small rates and rates near 0% or 100%. The native
difference uses the two-sample 95% Newcombe score interval for the aggregate
replacement rate minus the aggregate initial rate. These intervals quantify
sampling uncertainty over the cohort-aligned aggregate totals. Historical
intervals describe only their separate aggregate backfill and are not used for
the native comparison.

Analytics coverage starts only after analytics is enabled and the app is
published or republished. An empty opening portion of a cohort range is
missing coverage, not evidence of zero demand.

The SQL is guarded by an executable event/property fixture in
`src/lib/analytics.test.ts`. The fixture covers complete and incomplete
cohorts, the inclusive/exclusive follow-up boundaries, both confirmation
sources, source/cohort mismatches, mockup traffic, zero-request aggregate
rows, the legacy cutoff and explicit legacy marker, and subscriber-level
properties that must not enter the result.

## Privacy-safe query

This report uses only aggregate event counts and the allowlisted `source`,
`cohort`, and fixed `history=legacy` values. It does not select session IDs,
subscriber IDs, email addresses, URL query strings, confirmation tokens, or
any other subscriber-level data.

```sql
WITH
  now() AS report_at,
  toDateTime('2026-09-10 00:00:00') AS historical_cutoff,
  INTERVAL 7 DAY AS request_cohort_days,
  INTERVAL 28 DAY AS follow_up_days,
  request_counts AS (
    SELECT
      events.event_name,
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
  aggregates AS (
    SELECT
      sources.source,
      coalesce(sum(request_counts.requests), 0) AS requests,
      coalesce(sum(confirmation_counts.confirmations), 0) AS confirmations
    FROM sources
    LEFT JOIN (
      SELECT
        if(
          event_name = 'subscription_confirmation_requested',
          'initial',
          'replacement'
        ) AS source,
        requests,
        cohort
      FROM request_counts
    ) AS request_counts USING source
    LEFT JOIN confirmation_counts USING source, cohort
    GROUP BY sources.source
  ),
  rates AS (
    SELECT
      *,
      if(requests = 0, NULL, confirmations / requests) AS rate,
      1.959963984540054 AS z,
      z * z AS z_squared
    FROM aggregates
  ),
  intervals AS (
    SELECT
      *,
      if(
        requests = 0,
        NULL,
        (rate + z_squared / (2 * requests)) / (1 + z_squared / requests)
      ) AS interval_center,
      if(
        requests = 0,
        NULL,
        z * sqrt((rate * (1 - rate) + z_squared / (4 * requests)) / requests)
          / (1 + z_squared / requests)
      ) AS interval_margin
    FROM rates
  ),
  bounded_intervals AS (
    SELECT
      *,
      greatest(0, interval_center - interval_margin) AS interval_lower,
      least(1, interval_center + interval_margin) AS interval_upper
    FROM intervals
  ),
  comparison AS (
    SELECT
      maxIf(requests, source = 'initial') AS initial_requests,
      maxIf(requests, source = 'replacement') AS replacement_requests,
      maxIf(rate, source = 'initial') AS initial_rate,
      maxIf(rate, source = 'replacement') AS replacement_rate,
      maxIf(interval_lower, source = 'initial') AS initial_lower,
      maxIf(interval_upper, source = 'initial') AS initial_upper,
      maxIf(interval_lower, source = 'replacement') AS replacement_lower,
      maxIf(interval_upper, source = 'replacement') AS replacement_upper,
      replacement_rate - initial_rate AS rate_difference,
      rate_difference - sqrt(
        pow(replacement_rate - replacement_lower, 2)
        + pow(initial_upper - initial_rate, 2)
      ) AS difference_lower,
      rate_difference + sqrt(
        pow(replacement_upper - replacement_rate, 2)
        + pow(initial_rate - initial_lower, 2)
      ) AS difference_upper
    FROM bounded_intervals
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
      AND cohort.event_id IS NULL
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
      sources.source,
      coalesce(legacy_request_counts.requests, 0) AS requests,
      coalesce(legacy_confirmation_counts.confirmations, 0) AS confirmations
    FROM sources
    LEFT JOIN legacy_request_counts USING source
    LEFT JOIN legacy_confirmation_counts USING source
  ),
  historical_rates AS (
    SELECT
      *,
      if(requests = 0, NULL, confirmations / requests) AS rate,
      1.959963984540054 AS z,
      z * z AS z_squared
    FROM historical_aggregates
  ),
  historical_intervals AS (
    SELECT
      *,
      if(
        requests = 0,
        NULL,
        (rate + z_squared / (2 * requests)) / (1 + z_squared / requests)
      ) AS interval_center,
      if(
        requests = 0,
        NULL,
        z * sqrt((rate * (1 - rate) + z_squared / (4 * requests)) / requests)
          / (1 + z_squared / requests)
      ) AS interval_margin
    FROM historical_rates
  ),
  historical_bounded_intervals AS (
    SELECT
      *,
      greatest(0, interval_center - interval_margin) AS interval_lower,
      least(1, interval_center + interval_margin) AS interval_upper
    FROM historical_intervals
  )
SELECT
  'cohort_aligned' AS report_section,
  source,
  requests,
  confirmations,
  round(rate * 100, 1) AS conversion_rate_percent,
  round(interval_lower * 100, 1) AS ci_95_lower_percent,
  round(interval_upper * 100, 1) AS ci_95_upper_percent,
  round(comparison.rate_difference * 100, 1) AS replacement_lift_points,
  round(comparison.difference_lower * 100, 1) AS lift_ci_95_lower_points,
  round(comparison.difference_upper * 100, 1) AS lift_ci_95_upper_points,
  multiIf(
    comparison.initial_requests < 30 OR comparison.replacement_requests < 30,
      'inconclusive: sample too small',
    comparison.difference_lower > 0,
      'replacement outperforms',
    comparison.difference_upper < 0,
      'replacement underperforms',
    'inconclusive: difference includes zero'
  ) AS comparison_result
FROM bounded_intervals
CROSS JOIN comparison
UNION ALL
SELECT
  'historical_aggregate_only' AS report_section,
  source,
  requests,
  confirmations,
  round(rate * 100, 1) AS conversion_rate_percent,
  round(interval_lower * 100, 1) AS ci_95_lower_percent,
  round(interval_upper * 100, 1) AS ci_95_upper_percent,
  NULL AS replacement_lift_points,
  NULL AS lift_ci_95_lower_points,
  NULL AS lift_ci_95_upper_points,
  NULL AS comparison_result
FROM historical_bounded_intervals
ORDER BY report_section, source;
```

The query returns two rows for each `report_section`. Present the native
`comparison_result`, lift, and interval above the cohort-aligned table.
Present the historical rows as aggregate-only context, without combining them
with native rates or drawing a source comparison from them.