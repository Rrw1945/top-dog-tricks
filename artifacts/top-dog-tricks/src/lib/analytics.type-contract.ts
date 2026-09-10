import { trackEvent } from './analytics';

trackEvent('subscription_confirmation_requested', {
  location: 'homepage_newsletter',
  request_type: 'initial',
  cohort: '2026-09-07',
});

trackEvent('subscription_confirmation_replacement_requested', {
  location: 'homepage_newsletter',
  request_type: 'replacement',
  cohort: '2026-09-07',
});

trackEvent('subscription_confirmed', {
  location: 'email_confirmation',
  outcome: 'confirmed',
  source: 'initial',
  cohort: '2026-09-07',
});

trackEvent('subscription_confirmed', {
  location: 'email_confirmation',
  outcome: 'confirmed',
  source: 'initial',
  history: 'legacy',
});

trackEvent('contest_entry_started', {
  step: 1,
  location: 'homepage',
  resumed: false,
});

trackEvent('page_view');

const privateNewsletterPayload = {
  location: 'homepage_newsletter',
  request_type: 'initial',
  cohort: '2026-09-07',
  email: 'private@example.com',
} as const;

// @ts-expect-error Predeclared payloads cannot bypass the newsletter allowlist.
trackEvent('subscription_confirmation_requested', privateNewsletterPayload);

trackEvent('subscription_confirmation_requested', {
  location: 'homepage_newsletter',
  request_type: 'initial',
  cohort: '2026-09-07',
  // @ts-expect-error Newsletter analytics must not accept subscriber details.
  email: 'private@example.com',
});

trackEvent('subscription_confirmation_requested', {
  location: 'homepage_newsletter',
  request_type: 'initial',
  cohort: '2026-09-07',
  // @ts-expect-error Newsletter analytics must reject every non-allowlisted field.
  subscriber_id: 'private-id',
});

trackEvent('subscription_confirmation_requested', {
  // @ts-expect-error Each newsletter event has a fixed location.
  location: 'homepage_newsletter',
  // @ts-expect-error Each newsletter event has a fixed request type.
  request_type: 'replacement',
});

// @ts-expect-error Newsletter events require their full allowlisted payload.
trackEvent('subscription_confirmed', {
  location: 'email_confirmation',
  cohort: '2026-09-07',
});

const invalidConfirmationSourcePayload = {
  location: 'email_confirmation',
  outcome: 'confirmed',
  source: 'subscriber@example.com',
  cohort: '2026-09-07',
} as const;

// @ts-expect-error Confirmation analytics accepts only the privacy-safe source enum.
trackEvent('subscription_confirmed', invalidConfirmationSourcePayload);

const invalidLegacyConfirmationPayload = {
  location: 'email_confirmation',
  outcome: 'confirmed',
  source: 'initial',
  history: 'legacy',
  cohort: '2026-09-07',
} as const;

// @ts-expect-error Native cohort and legacy history markers must not be combined.
trackEvent('subscription_confirmed', invalidLegacyConfirmationPayload);

const privateConfirmationPayload = {
  location: 'email_confirmation',
  outcome: 'confirmed',
  source: 'replacement',
  cohort: '2026-09-07',
  subscriber_id: 'private-id',
} as const;

// @ts-expect-error Predeclared confirmation payloads cannot bypass the identifier allowlist.
trackEvent('subscription_confirmed', privateConfirmationPayload);