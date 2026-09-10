type AnalyticsData = Record<string, string | number | boolean>;

export const MIN_CONFIRMATION_COMPARISON_REQUESTS = 30;
export const CONFIRMATION_COHORT_DAYS = 7;
export const CONFIRMATION_FOLLOW_UP_DAYS = 28;

const UTC_DAY_MS = 24 * 60 * 60 * 1_000;
const COHORT_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type ConversionInterval = {
  rate: number;
  lower: number;
  upper: number;
};

export type ConfirmationRateComparison = {
  initial: ConversionInterval;
  replacement: ConversionInterval;
  difference: ConversionInterval;
  conclusion: 'inconclusive' | 'replacement_outperforms' | 'replacement_underperforms';
  reason: 'sample_too_small' | 'difference_includes_zero' | 'statistically_clear';
};

const Z_95 = 1.959963984540054;

export function getConfirmationCohort(date = new Date()): string {
  const daysSinceMonday = (date.getUTCDay() + 6) % CONFIRMATION_COHORT_DAYS;
  const cohortStart = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
      - daysSinceMonday * UTC_DAY_MS,
  );
  return cohortStart.toISOString().slice(0, 10);
}

export function isConfirmationCohort(value: string): boolean {
  if (!COHORT_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && getConfirmationCohort(parsed) === value;
}

function assertAggregateCount(label: string, successes: number, total: number): void {
  if (
    !Number.isInteger(successes)
    || !Number.isInteger(total)
    || successes < 0
    || total <= 0
    || successes > total
  ) {
    throw new RangeError(`${label} must have integer confirmations between 0 and requests`);
  }
}

export function calculateConversionInterval(
  confirmations: number,
  requests: number,
): ConversionInterval {
  assertAggregateCount('Conversion aggregate', confirmations, requests);

  const rate = confirmations / requests;
  const zSquared = Z_95 ** 2;
  const denominator = 1 + zSquared / requests;
  const center = (rate + zSquared / (2 * requests)) / denominator;
  const margin = (
    Z_95
    * Math.sqrt((rate * (1 - rate) + zSquared / (4 * requests)) / requests)
    / denominator
  );

  return {
    rate,
    lower: Math.max(0, center - margin),
    upper: Math.min(1, center + margin),
  };
}

export function compareConfirmationRates(
  initialConfirmations: number,
  initialRequests: number,
  replacementConfirmations: number,
  replacementRequests: number,
): ConfirmationRateComparison {
  assertAggregateCount('Initial aggregate', initialConfirmations, initialRequests);
  assertAggregateCount('Replacement aggregate', replacementConfirmations, replacementRequests);

  const initial = calculateConversionInterval(initialConfirmations, initialRequests);
  const replacement = calculateConversionInterval(replacementConfirmations, replacementRequests);
  const rateDifference = replacement.rate - initial.rate;
  const difference = {
    rate: rateDifference,
    lower: Math.max(
      -1,
      rateDifference - Math.sqrt(
        (replacement.rate - replacement.lower) ** 2
        + (initial.upper - initial.rate) ** 2,
      ),
    ),
    upper: Math.min(
      1,
      rateDifference + Math.sqrt(
        (replacement.upper - replacement.rate) ** 2
        + (initial.rate - initial.lower) ** 2,
      ),
    ),
  };

  if (
    initialRequests < MIN_CONFIRMATION_COMPARISON_REQUESTS
    || replacementRequests < MIN_CONFIRMATION_COMPARISON_REQUESTS
  ) {
    return { initial, replacement, difference, conclusion: 'inconclusive', reason: 'sample_too_small' };
  }
  if (difference.lower > 0) {
    return {
      initial,
      replacement,
      difference,
      conclusion: 'replacement_outperforms',
      reason: 'statistically_clear',
    };
  }
  if (difference.upper < 0) {
    return {
      initial,
      replacement,
      difference,
      conclusion: 'replacement_underperforms',
      reason: 'statistically_clear',
    };
  }
  return {
    initial,
    replacement,
    difference,
    conclusion: 'inconclusive',
    reason: 'difference_includes_zero',
  };
}

type NewsletterEventCatalog = {
  subscription_confirmation_requested: {
    location: 'homepage_newsletter';
    request_type: 'initial';
    cohort: string;
  };
  subscription_confirmation_replacement_requested: {
    location: 'homepage_newsletter';
    request_type: 'replacement';
    cohort: string;
  };
  subscription_confirmed: {
    location: 'email_confirmation';
    outcome: 'confirmed';
    source: 'initial' | 'replacement';
    cohort: string;
  } | {
    location: 'email_confirmation';
    outcome: 'confirmed';
    source: 'initial' | 'replacement';
    history: 'legacy';
  };
};

type AnalyticsEventData<Name extends string> =
  Name extends keyof NewsletterEventCatalog ? NewsletterEventCatalog[Name] : AnalyticsData;

type ExactNewsletterEventData<
  Expected extends AnalyticsData,
  Data extends AnalyticsData,
> = Expected extends unknown
  ? Data
    & Expected
    & Record<Exclude<keyof Data, keyof Expected>, never>
  : never;

type TrackEventArgs<Name extends string, Data extends AnalyticsData | undefined> =
  Name extends keyof NewsletterEventCatalog
    ? Data extends AnalyticsData
      ? [
          data: Data
            & ExactNewsletterEventData<AnalyticsEventData<Name>, Data>,
        ]
      : [data: AnalyticsEventData<Name>]
    : [data?: Data];

declare global {
  interface Window {
    umami?: {
      track(name: string, data?: AnalyticsData): void;
    };
  }
}

export function trackEvent<
  const Name extends string,
  const Data extends AnalyticsData | undefined = undefined,
>(
  name: Name,
  ...[data]: TrackEventArgs<Name, Data>
): void {
  if (typeof window === 'undefined') return;

  try {
    window.umami?.track(name, data);
  } catch {
    // Analytics must never break the app.
  }
}

export function trackCompletedSubscriptionFromUrl(): boolean {
  if (typeof window === 'undefined') return false;

  const url = new URL(window.location.href);
  if (url.searchParams.get('subscription') !== 'confirmed') return false;

  const confirmationSource = url.searchParams.get('confirmation_source');
  const confirmationCohort = url.searchParams.get('confirmation_cohort');
  const confirmationHistory = url.searchParams.get('confirmation_history');
  url.searchParams.delete('subscription');
  url.searchParams.delete('confirmation_source');
  url.searchParams.delete('confirmation_cohort');
  url.searchParams.delete('confirmation_history');
  try {
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {
    // URL cleanup must not prevent the confirmation outcome from being shown.
  }

  if (
    (confirmationSource === 'initial' || confirmationSource === 'replacement')
    && confirmationCohort
    && isConfirmationCohort(confirmationCohort)
  ) {
    trackEvent('subscription_confirmed', {
      location: 'email_confirmation',
      outcome: 'confirmed',
      source: confirmationSource,
      cohort: confirmationCohort,
    });
  } else if (
    (confirmationSource === 'initial' || confirmationSource === 'replacement')
    && confirmationHistory === 'legacy'
  ) {
    trackEvent('subscription_confirmed', {
      location: 'email_confirmation',
      outcome: 'confirmed',
      source: confirmationSource,
      history: 'legacy',
    });
  }
  return true;
}