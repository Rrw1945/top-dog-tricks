import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  calculateConversionInterval,
  compareConfirmationRates,
  getConfirmationCohort,
  isConfirmationCohort,
  trackCompletedSubscriptionFromUrl,
  trackEvent,
} from './analytics';

type FunnelFixtureProperty = {
  data_key: string;
  data_type: number;
  string_value: string;
};

type FunnelFixtureEvent = {
  event: {
    created_at: string;
    event_id: string;
    event_name: string;
    event_type: number;
    url_path: string;
  };
  properties: FunnelFixtureProperty[];
};

type FunnelAggregate = {
  source: 'initial' | 'replacement';
  requests: number;
  confirmations: number;
  rate: number | null;
};

type HistoricalAggregate = FunnelAggregate;

const REPORT_AT = new Date('2026-09-09T00:00:00Z');
const HISTORICAL_CUTOFF = new Date('2026-09-10T00:00:00Z');
const REQUEST_COHORT_DAYS = 7;
const FOLLOW_UP_DAYS = 28;
const COMPLETE_COHORT = '2026-07-27';
const INITIAL_ONLY_COHORT = '2026-06-29';
const INCOMPLETE_COHORT = '2026-08-10';
const FUNNEL_QUERY_PATH = resolve(
  import.meta.dirname,
  '../../docs/newsletter-confirmation-funnel.md',
);

function property(
  data_key: string,
  string_value: string,
  data_type = 1,
): FunnelFixtureProperty {
  return { data_key, data_type, string_value };
}

function fixtureEvent(
  event_id: string,
  event_name: string,
  created_at: string,
  properties: FunnelFixtureProperty[],
  url_path = '/',
): FunnelFixtureEvent {
  return {
    event: {
      event_id,
      event_name,
      created_at,
      event_type: 2,
      url_path,
    },
    properties,
  };
}

function addDays(date: string, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function isCompleteCohort(cohort: string, reportAt: Date): boolean {
  const cohortStart = new Date(`${cohort}T00:00:00Z`);
  return (
    getConfirmationCohort(cohortStart) === cohort
    && addDays(cohort, REQUEST_COHORT_DAYS + FOLLOW_UP_DAYS) <= reportAt
  );
}

/**
 * This is a small executable model of the documented ClickHouse CTEs. Keeping
 * the fixture at the event/property level catches accidental changes to the
 * joins and cohort boundaries instead of only testing the final math helpers.
 */
function evaluateFunnelFixture(
  events: FunnelFixtureEvent[],
  reportAt = REPORT_AT,
): FunnelAggregate[] {
  const requestCounts = new Map<string, number>();

  for (const fixture of events) {
    const { event, properties } = fixture;
    if (
      event.event_type !== 2
      || ![
        'subscription_confirmation_requested',
        'subscription_confirmation_replacement_requested',
      ].includes(event.event_name)
      || event.url_path === '/__mockup'
      || event.url_path.startsWith('/__mockup/')
    ) {
      continue;
    }

    const cohortProperty = properties.find(
      (item) => item.data_key === 'cohort' && item.data_type === 1,
    );
    if (!cohortProperty || !isCompleteCohort(cohortProperty.string_value, reportAt)) {
      continue;
    }

    const key = `${event.event_name}:${cohortProperty.string_value}`;
    requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
  }

  const eligibleCohorts = new Set(
    [...requestCounts.keys()].map((key) => key.slice(key.indexOf(':') + 1)),
  );
  const confirmationCounts = new Map<string, number>();

  for (const fixture of events) {
    const { event, properties } = fixture;
    if (
      event.event_type !== 2
      || event.event_name !== 'subscription_confirmed'
      || event.url_path === '/__mockup'
      || event.url_path.startsWith('/__mockup/')
    ) {
      continue;
    }

    const cohortProperty = properties.find(
      (item) => item.data_key === 'cohort' && item.data_type === 1,
    );
    const sourceProperty = properties.find(
      (item) => item.data_key === 'source' && item.data_type === 1,
    );
    if (
      !cohortProperty
      || !sourceProperty
      || !eligibleCohorts.has(cohortProperty.string_value)
      || !['initial', 'replacement'].includes(sourceProperty.string_value)
    ) {
      continue;
    }

    const cohortStart = new Date(`${cohortProperty.string_value}T00:00:00Z`);
    const confirmationAt = new Date(event.created_at);
    const followUpEnd = addDays(
      cohortProperty.string_value,
      REQUEST_COHORT_DAYS + FOLLOW_UP_DAYS,
    );
    if (
      confirmationAt < cohortStart
      || confirmationAt >= followUpEnd
    ) {
      continue;
    }

    const source = sourceProperty.string_value as 'initial' | 'replacement';
    const key = `${source}:${cohortProperty.string_value}`;
    confirmationCounts.set(key, (confirmationCounts.get(key) ?? 0) + 1);
  }

  return (['initial', 'replacement'] as const).map((source) => {
    const requests = [...requestCounts.entries()]
      .filter(([key]) => key.startsWith(
        source === 'initial'
          ? 'subscription_confirmation_requested:'
          : 'subscription_confirmation_replacement_requested:',
      ))
      .reduce((total, [, count]) => total + count, 0);
    const confirmations = [...confirmationCounts.entries()]
      .filter(([key]) => {
        const [, cohort] = key.split(':');
        const requestEventName = source === 'initial'
          ? 'subscription_confirmation_requested'
          : 'subscription_confirmation_replacement_requested';
        return key.startsWith(`${source}:`)
          && requestCounts.has(`${requestEventName}:${cohort}`);
      })
      .reduce((total, [, count]) => total + count, 0);

    return {
      source,
      requests,
      confirmations,
      rate: requests === 0 ? null : confirmations / requests,
    };
  });
}

function evaluateHistoricalFixture(events: FunnelFixtureEvent[]): HistoricalAggregate[] {
  const requests = new Map<'initial' | 'replacement', number>();
  const confirmations = new Map<'initial' | 'replacement', number>();

  for (const fixture of events) {
    const { event, properties } = fixture;
    if (
      event.event_type !== 2
      || event.url_path === '/__mockup'
      || event.url_path.startsWith('/__mockup/')
    ) {
      continue;
    }

    const cohort = properties.find(
      (item) => item.data_key === 'cohort' && item.data_type === 1,
    );
    if (
      !cohort
      && event.created_at < HISTORICAL_CUTOFF.toISOString()
      && (
        event.event_name === 'subscription_confirmation_requested'
        || event.event_name === 'subscription_confirmation_replacement_requested'
      )
    ) {
      const source = event.event_name === 'subscription_confirmation_requested'
        ? 'initial'
        : 'replacement';
      requests.set(source, (requests.get(source) ?? 0) + 1);
    }

    if (event.event_name !== 'subscription_confirmed' || cohort) continue;
    const sourceProperty = properties.find(
      (item) => item.data_key === 'source' && item.data_type === 1,
    );
    const historyProperty = properties.find(
      (item) => item.data_key === 'history' && item.data_type === 1,
    );
    if (
      (historyProperty?.string_value !== 'legacy'
        && event.created_at >= HISTORICAL_CUTOFF.toISOString())
      || !sourceProperty
      || !['initial', 'replacement'].includes(sourceProperty.string_value)
    ) {
      continue;
    }
    const source = sourceProperty.string_value as 'initial' | 'replacement';
    confirmations.set(source, (confirmations.get(source) ?? 0) + 1);
  }

  return (['initial', 'replacement'] as const).map((source) => {
    const requestCount = requests.get(source) ?? 0;
    const confirmationCount = confirmations.get(source) ?? 0;
    return {
      source,
      requests: requestCount,
      confirmations: confirmationCount,
      rate: requestCount === 0 ? null : confirmationCount / requestCount,
    };
  });
}

function documentedFunnelQuery(): string {
  const document = readFileSync(FUNNEL_QUERY_PATH, 'utf8');
  const query = document.match(/```sql\n([\s\S]*?)\n```/)?.[1];
  if (!query) {
    throw new Error('Newsletter funnel document is missing its SQL query');
  }
  return query;
}

describe('newsletter confirmation funnel query', () => {
  it('keeps event-property joins, cohort boundaries, and privacy constraints executable', () => {
    const query = documentedFunnelQuery();
    const finalSelect = query.slice(query.lastIndexOf('SELECT\n  source'));

    expect(query).toContain(
      'INNER JOIN website_event AS events\n      ON events.event_id = properties.event_id',
    );
    expect(query).toContain(
      'LEFT JOIN event_data AS source\n      ON source.event_id = properties.event_id',
    );
    expect(query).toContain(
      'AND toDateTime(properties.string_value) + request_cohort_days + follow_up_days <= report_at',
    );
    expect(query).toContain(
      "AND match(properties.string_value, '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')",
    );
    expect(query).toContain(
      'AND toDayOfWeek(toDate(properties.string_value)) = 1',
    );
    expect(query).toContain(
      'AND events.created_at < toDateTime(properties.string_value) + request_cohort_days + follow_up_days',
    );
    expect(query).toContain(
      'AND properties.string_value IN (SELECT cohort FROM eligible_cohorts)',
    );
    expect(query).toContain(
      "toDateTime('2026-09-10 00:00:00') AS historical_cutoff",
    );
    expect(query).toContain('legacy_request_counts');
    expect(query).toContain('history = \'legacy\'');
    expect(query).toContain("'cohort_aligned' AS report_section");
    expect(query).toContain("'historical_aggregate_only' AS report_section");
    expect(query).toContain("arrayJoin(['initial', 'replacement']) AS source");
    expect(query).toContain('if(requests = 0, NULL, confirmations / requests) AS rate');
    expect(finalSelect).not.toMatch(
      /\b(session_id|subscriber_id|email|token|url_query)\b/i,
    );

    const results = evaluateFunnelFixture([
      fixtureEvent(
        'request-initial-complete',
        'subscription_confirmation_requested',
        '2026-07-27T10:00:00Z',
        [
          property('cohort', COMPLETE_COHORT),
          property('subscriber_email', 'owner@example.com'),
          property('confirmation_token', 'secret-token'),
        ],
      ),
      fixtureEvent(
        'request-initial-complete-2',
        'subscription_confirmation_requested',
        '2026-07-28T10:00:00Z',
        [property('cohort', COMPLETE_COHORT)],
      ),
      fixtureEvent(
        'request-replacement-complete',
        'subscription_confirmation_replacement_requested',
        '2026-07-29T10:00:00Z',
        [property('cohort', COMPLETE_COHORT)],
      ),
      fixtureEvent(
        'request-initial-only',
        'subscription_confirmation_requested',
        '2026-06-30T10:00:00Z',
        [property('cohort', INITIAL_ONLY_COHORT)],
      ),
      fixtureEvent(
        'request-initial-incomplete',
        'subscription_confirmation_requested',
        '2026-08-10T10:00:00Z',
        [property('cohort', INCOMPLETE_COHORT)],
      ),
      fixtureEvent(
        'request-replacement-incomplete',
        'subscription_confirmation_replacement_requested',
        '2026-08-11T10:00:00Z',
        [property('cohort', INCOMPLETE_COHORT)],
      ),
      fixtureEvent(
        'confirmation-initial-in-window',
        'subscription_confirmed',
        '2026-08-30T23:59:59Z',
        [property('cohort', COMPLETE_COHORT), property('source', 'initial')],
      ),
      fixtureEvent(
        'confirmation-replacement-in-window',
        'subscription_confirmed',
        '2026-08-30T23:59:59Z',
        [property('cohort', COMPLETE_COHORT), property('source', 'replacement')],
      ),
      fixtureEvent(
        'confirmation-at-follow-up-boundary',
        'subscription_confirmed',
        '2026-08-31T00:00:00Z',
        [property('cohort', COMPLETE_COHORT), property('source', 'initial')],
      ),
      fixtureEvent(
        'confirmation-incomplete-cohort',
        'subscription_confirmed',
        '2026-08-20T10:00:00Z',
        [property('cohort', INCOMPLETE_COHORT), property('source', 'initial')],
      ),
      fixtureEvent(
        'confirmation-before-cohort',
        'subscription_confirmed',
        '2026-07-26T23:59:59Z',
        [property('cohort', COMPLETE_COHORT), property('source', 'initial')],
      ),
      fixtureEvent(
        'confirmation-from-mockup',
        'subscription_confirmed',
        '2026-08-01T10:00:00Z',
        [property('cohort', COMPLETE_COHORT), property('source', 'initial')],
        '/__mockup/confirmation',
      ),
      fixtureEvent(
        'confirmation-cross-source',
        'subscription_confirmed',
        '2026-08-01T10:00:00Z',
        [property('cohort', INITIAL_ONLY_COHORT), property('source', 'replacement')],
      ),
    ]);

    expect(results).toEqual([
      { source: 'initial', requests: 3, confirmations: 1, rate: 1 / 3 },
      { source: 'replacement', requests: 1, confirmations: 1, rate: 1 },
    ]);
    expect(Object.keys(results[0])).toEqual([
      'source',
      'requests',
      'confirmations',
      'rate',
    ]);
  });

  it('keeps pre-cutoff history aggregate-only and never pairs it to a cohort', () => {
    expect(evaluateHistoricalFixture([
      fixtureEvent(
        'legacy-initial-request',
        'subscription_confirmation_requested',
        '2026-09-08T10:00:00Z',
        [property('subscriber_email', 'owner@example.com')],
      ),
      fixtureEvent(
        'legacy-replacement-request',
        'subscription_confirmation_replacement_requested',
        '2026-09-08T11:00:00Z',
        [],
      ),
      fixtureEvent(
        'legacy-initial-confirmation',
        'subscription_confirmed',
        '2026-09-10T10:00:00Z',
        [
          property('source', 'initial'),
          property('history', 'legacy'),
          property('subscriber_id', 'private-id'),
        ],
      ),
      fixtureEvent(
        'old-confirmation-without-marker',
        'subscription_confirmed',
        '2026-09-08T12:00:00Z',
        [property('source', 'replacement')],
      ),
      fixtureEvent(
        'native-confirmation-not-backfilled',
        'subscription_confirmed',
        '2026-09-08T13:00:00Z',
        [property('source', 'initial'), property('cohort', COMPLETE_COHORT)],
      ),
      fixtureEvent(
        'legacy-mockup-request',
        'subscription_confirmation_requested',
        '2026-09-08T14:00:00Z',
        [],
        '/__mockup/newsletter',
      ),
    ])).toEqual([
      { source: 'initial', requests: 1, confirmations: 1, rate: 1 },
      { source: 'replacement', requests: 1, confirmations: 1, rate: 1 },
    ]);
  });

  it('keeps both aggregate rows and null rates when there are no requests', () => {
    expect(evaluateFunnelFixture([])).toEqual([
      { source: 'initial', requests: 0, confirmations: 0, rate: null },
      { source: 'replacement', requests: 0, confirmations: 0, rate: null },
    ]);
  });
});

describe('confirmation conversion statistics', () => {
  it('assigns dates to fixed Monday-starting UTC cohorts', () => {
    expect(getConfirmationCohort(new Date('2026-09-09T12:00:00Z'))).toBe('2026-09-07');
    expect(getConfirmationCohort(new Date('2026-09-06T23:59:59Z'))).toBe('2026-08-31');
    expect(isConfirmationCohort('2026-09-07')).toBe(true);
    expect(isConfirmationCohort('2026-09-09')).toBe(false);
  });

  it('calculates a 95% Wilson interval for an aggregate conversion rate', () => {
    expect(calculateConversionInterval(50, 100)).toEqual({
      rate: 0.5,
      lower: expect.closeTo(0.4038, 4),
      upper: expect.closeTo(0.5962, 4),
    });
  });

  it('labels a small aggregate comparison as inconclusive', () => {
    const comparison = compareConfirmationRates(10, 20, 18, 20);

    expect(comparison.conclusion).toBe('inconclusive');
    expect(comparison.reason).toBe('sample_too_small');
  });

  it('detects when replacement conversion clearly exceeds the initial baseline', () => {
    const comparison = compareConfirmationRates(30, 100, 60, 100);

    expect(comparison.conclusion).toBe('replacement_outperforms');
    expect(comparison.reason).toBe('statistically_clear');
    expect(comparison.difference).toEqual({
      rate: expect.closeTo(0.3, 10),
      lower: expect.closeTo(0.1629, 4),
      upper: expect.closeTo(0.4216, 4),
    });
  });

  it('keeps overlapping aggregate rates inconclusive', () => {
    const comparison = compareConfirmationRates(40, 100, 45, 100);

    expect(comparison.conclusion).toBe('inconclusive');
    expect(comparison.reason).toBe('difference_includes_zero');
  });

  it('rejects counts that cannot represent a conversion aggregate', () => {
    expect(() => calculateConversionInterval(11, 10)).toThrow(RangeError);
  });

  it('preserves uncertainty when both groups have zero confirmations', () => {
    const comparison = compareConfirmationRates(0, 30, 0, 30);

    expect(comparison.conclusion).toBe('inconclusive');
    expect(comparison.reason).toBe('difference_includes_zero');
    expect(comparison.difference).toEqual({
      rate: 0,
      lower: expect.closeTo(-0.1135, 4),
      upper: expect.closeTo(0.1135, 4),
    });
  });

  it('does not overstate a sparse 3-of-30 versus 9-of-30 difference', () => {
    const comparison = compareConfirmationRates(3, 30, 9, 30);

    expect(comparison.conclusion).toBe('inconclusive');
    expect(comparison.reason).toBe('difference_includes_zero');
    expect(comparison.difference).toEqual({
      rate: expect.closeTo(0.2, 10),
      lower: expect.closeTo(-0.0054, 4),
      upper: expect.closeTo(0.3903, 4),
    });
  });
});

describe('trackEvent', () => {
  afterEach(() => {
    delete window.umami;
    window.history.replaceState({}, '', '/');
  });

  it('does not let a throwing analytics client change application behavior', () => {
    window.umami = {
      track: vi.fn(() => {
        throw new Error('analytics unavailable');
      }),
    };

    expect(() =>
      trackEvent('subscription_confirmation_requested', {
        location: 'homepage_newsletter',
        request_type: 'initial',
        cohort: '2026-09-07',
      }),
    ).not.toThrow();
  });

  it.each(['initial', 'replacement'] as const)(
    'tracks a non-PII %s confirmation outcome and removes its URL markers',
    (source) => {
      const track = vi.fn();
      window.umami = { track };
      window.history.replaceState(
        {},
        '',
        `/?subscription=confirmed&confirmation_source=${source}&confirmation_cohort=2026-09-07#newsletter`,
      );

      expect(trackCompletedSubscriptionFromUrl()).toBe(true);

      expect(track).toHaveBeenCalledWith('subscription_confirmed', {
        location: 'email_confirmation',
        outcome: 'confirmed',
        source,
        cohort: '2026-09-07',
      });
      expect(window.location.search).toBe('');
      expect(window.location.hash).toBe('#newsletter');
    },
  );

  it('shows confirmation without tracking when the source is not allowlisted', () => {
    const track = vi.fn();
    window.umami = { track };
    window.history.replaceState(
      {},
      '',
      '/?subscription=confirmed&confirmation_source=private-value#newsletter',
    );

    expect(trackCompletedSubscriptionFromUrl()).toBe(true);

    expect(track).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#newsletter');
  });

  it('shows confirmation without tracking when its cohort marker is incomplete', () => {
    const track = vi.fn();
    window.umami = { track };
    window.history.replaceState(
      {},
      '',
      '/?subscription=confirmed&confirmation_source=initial&confirmation_cohort=2026-09-09#newsletter',
    );

    expect(trackCompletedSubscriptionFromUrl()).toBe(true);

    expect(track).not.toHaveBeenCalled();
    expect(window.location.search).toBe('');
    expect(window.location.hash).toBe('#newsletter');
  });

  it.each(['initial', 'replacement'] as const)(
    'tracks a %s confirmation from an older link as legacy aggregate history',
    (source) => {
      const track = vi.fn();
      window.umami = { track };
      window.history.replaceState(
        {},
        '',
        `/?subscription=confirmed&confirmation_source=${source}&confirmation_history=legacy#newsletter`,
      );

      expect(trackCompletedSubscriptionFromUrl()).toBe(true);

      expect(track).toHaveBeenCalledWith('subscription_confirmed', {
        location: 'email_confirmation',
        outcome: 'confirmed',
        source,
        history: 'legacy',
      });
      expect(window.location.search).toBe('');
      expect(window.location.hash).toBe('#newsletter');
    },
  );

  it('does not track unrelated URLs', () => {
    const track = vi.fn();
    window.umami = { track };

    expect(trackCompletedSubscriptionFromUrl()).toBe(false);
    expect(track).not.toHaveBeenCalled();
  });
});