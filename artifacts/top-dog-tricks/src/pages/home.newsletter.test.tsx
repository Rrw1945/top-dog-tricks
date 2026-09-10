import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createSubscriberOptions: undefined as
    | {
        mutation?: {
          onSuccess?: (result: { message: string }, variables: { data: { email: string } }) => void;
          onError?: () => void;
        };
      }
    | undefined,
  resendOptions: undefined as
    | { mutation?: { onSuccess?: (result: { message: string; cohort: string }) => void; onError?: () => void } }
    | undefined,
  createSubscriberMutate: vi.fn(),
  resendMutate: vi.fn(),
  trackEvent: vi.fn(),
  trackCompletedSubscriptionFromUrl: vi.fn(() => false),
}));

vi.mock('@workspace/api-client-react', () => ({
  getGetStoredObjectQueryKey: vi.fn(),
  getListShowcaseEntriesQueryKey: vi.fn(),
  useCreateSubmission: vi.fn(),
  useGetStoredObject: vi.fn(),
  useListShowcaseEntries: vi.fn(),
  useRequestUploadUrl: vi.fn(),
  useCreateSubscriber: (options: typeof mocks.createSubscriberOptions) => {
    mocks.createSubscriberOptions = options;
    return { isPending: false, mutate: mocks.createSubscriberMutate };
  },
  useResendSubscriberConfirmation: (options: typeof mocks.resendOptions) => {
    mocks.resendOptions = options;
    return { isPending: false, mutate: mocks.resendMutate };
  },
}));

vi.mock('@/components/top-dog', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  BrandMark: vi.fn(),
  FileDrop: vi.fn(),
  LikeButton: vi.fn(),
  SectionKicker: vi.fn(),
  SubmitLoader: vi.fn(),
}));

vi.mock('@/lib/analytics', () => ({
  trackEvent: mocks.trackEvent,
  trackCompletedSubscriptionFromUrl: mocks.trackCompletedSubscriptionFromUrl,
}));

import { NewsletterSignup } from './home';

const STORAGE_KEY = 'top-dog-tricks:subscriber-resend';
const FIFTEEN_MINUTES = 15 * 60 * 1_000;
const START_TIME = new Date('2026-09-09T12:00:00Z');

describe('newsletter confirmation requests', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START_TIME);
    localStorage.clear();
    mocks.createSubscriberMutate.mockReset();
    mocks.resendMutate.mockReset();
    mocks.trackEvent.mockReset();
    mocks.trackCompletedSubscriptionFromUrl.mockReset();
    mocks.trackCompletedSubscriptionFromUrl.mockReturnValue(false);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('preserves the full deadline across reload and starts a fresh cooldown after replacement', () => {
    mocks.createSubscriberMutate.mockImplementation((variables) => {
      mocks.createSubscriberOptions?.mutation?.onSuccess?.(
        { message: 'Check your inbox', cohort: '2026-09-07' },
        variables,
      );
    });
    mocks.resendMutate.mockImplementation(() => {
      mocks.resendOptions?.mutation?.onSuccess?.({
        message: 'Replacement sent',
        cohort: '2026-09-07',
      });
    });

    const firstView = render(<NewsletterSignup />);
    fireEvent.change(screen.getByTestId('input-subscriber-email'), {
      target: { value: 'Subscriber@Example.com' },
    });
    fireEvent.click(screen.getByTestId('checkbox-subscriber-consent'));
    fireEvent.submit(screen.getByTestId('input-subscriber-email').closest('form')!);

    const initialDeadline = START_TIME.getTime() + FIFTEEN_MINUTES;
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({
      email: 'subscriber@example.com',
      cooldownEndsAt: initialDeadline,
    });
    expect(screen.getByTestId('button-resend-subscriber-confirmation')).toBeDisabled();
    expect(screen.getByText(/another email in 15:00/)).toBeInTheDocument();

    firstView.unmount();
    render(<NewsletterSignup />);
    expect(screen.getByTestId('button-resend-subscriber-confirmation')).toBeDisabled();
    expect(screen.getByText(/another email in 15:00/)).toBeInTheDocument();

    vi.setSystemTime(initialDeadline - 1);
    expect(screen.getByTestId('button-resend-subscriber-confirmation')).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    const resendButton = screen.getByTestId('button-resend-subscriber-confirmation');
    expect(resendButton).toBeEnabled();

    fireEvent.click(resendButton);
    expect(mocks.resendMutate).toHaveBeenCalledWith({
      data: { email: 'subscriber@example.com' },
    });
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!)).toEqual({
      email: 'subscriber@example.com',
      cooldownEndsAt: Date.now() + FIFTEEN_MINUTES,
    });
    expect(resendButton).toBeDisabled();

    expect(mocks.trackEvent.mock.calls).toEqual([
      [
        'subscription_confirmation_requested',
        { location: 'homepage_newsletter', request_type: 'initial', cohort: '2026-09-07' },
      ],
      [
        'subscription_confirmation_replacement_requested',
        { location: 'homepage_newsletter', request_type: 'replacement', cohort: '2026-09-07' },
      ],
    ]);
  });

  it('keeps successful initial and replacement requests working when storage writes fail', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Storage is unavailable', 'SecurityError');
    });
    mocks.createSubscriberMutate.mockImplementation((variables) => {
      mocks.createSubscriberOptions?.mutation?.onSuccess?.(
        { message: 'Check your inbox', cohort: '2026-09-07' },
        variables,
      );
    });
    mocks.resendMutate.mockImplementation(() => {
      mocks.resendOptions?.mutation?.onSuccess?.({
        message: 'Replacement sent',
        cohort: '2026-09-07',
      });
    });

    render(<NewsletterSignup />);
    fireEvent.change(screen.getByTestId('input-subscriber-email'), {
      target: { value: 'Restricted@Example.com' },
    });
    fireEvent.click(screen.getByTestId('checkbox-subscriber-consent'));
    fireEvent.submit(screen.getByTestId('input-subscriber-email').closest('form')!);

    expect(screen.getByTestId('status-subscriber')).toHaveTextContent('Check your inbox');
    expect(screen.getByText(/another email in 15:00/)).toBeInTheDocument();
    expect(screen.getByTestId('button-resend-subscriber-confirmation')).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(FIFTEEN_MINUTES);
    });
    const resendButton = screen.getByTestId('button-resend-subscriber-confirmation');
    expect(resendButton).toBeEnabled();

    fireEvent.click(resendButton);

    expect(mocks.resendMutate).toHaveBeenCalledOnce();
    expect(mocks.resendMutate).toHaveBeenCalledWith({
      data: { email: 'restricted@example.com' },
    });
    expect(screen.getByTestId('status-subscriber')).toHaveTextContent('Replacement sent');
    expect(screen.getByText(/another email in 15:00/)).toBeInTheDocument();
    expect(resendButton).toBeDisabled();
    expect(setItem).toHaveBeenCalledTimes(2);
    expect(mocks.trackEvent.mock.calls).toEqual([
      [
        'subscription_confirmation_requested',
        { location: 'homepage_newsletter', request_type: 'initial', cohort: '2026-09-07' },
      ],
      [
        'subscription_confirmation_replacement_requested',
        { location: 'homepage_newsletter', request_type: 'replacement', cohort: '2026-09-07' },
      ],
    ]);

  });

  it('renders and remains interactive when storage reads are blocked', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('Storage is unavailable', 'SecurityError');
    });

    render(<NewsletterSignup />);
    fireEvent.change(screen.getByTestId('input-subscriber-email'), {
      target: { value: 'restricted@example.com' },
    });
    fireEvent.click(screen.getByTestId('checkbox-subscriber-consent'));
    fireEvent.submit(screen.getByTestId('input-subscriber-email').closest('form')!);

    expect(screen.getByTestId('input-subscriber-email')).toHaveValue('restricted@example.com');
    expect(mocks.createSubscriberMutate).toHaveBeenCalledWith({
      data: { email: 'restricted@example.com', consent: true },
    });
    expect(getItem).toHaveBeenCalledWith(STORAGE_KEY);
  });

  it('renders and remains interactive when invalid storage cannot be removed', () => {
    localStorage.setItem(STORAGE_KEY, '{invalid-json');
    const removeItem = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('Storage is unavailable', 'SecurityError');
    });

    render(<NewsletterSignup />);
    fireEvent.change(screen.getByTestId('input-subscriber-email'), {
      target: { value: 'subscriber@example.com' },
    });
    fireEvent.click(screen.getByTestId('checkbox-subscriber-consent'));
    fireEvent.submit(screen.getByTestId('input-subscriber-email').closest('form')!);

    expect(mocks.createSubscriberMutate).toHaveBeenCalledWith({
      data: { email: 'subscriber@example.com', consent: true },
    });
    expect(removeItem).toHaveBeenCalledWith(STORAGE_KEY);
  });

  it('does not emit success analytics when initial or replacement requests fail', () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        email: 'subscriber@example.com',
        cooldownEndsAt: START_TIME.getTime(),
      }),
    );
    mocks.createSubscriberMutate.mockImplementation(() => {
      mocks.createSubscriberOptions?.mutation?.onError?.();
    });
    mocks.resendMutate.mockImplementation(() => {
      mocks.resendOptions?.mutation?.onError?.();
    });

    render(<NewsletterSignup />);
    fireEvent.change(screen.getByTestId('input-subscriber-email'), {
      target: { value: 'private@example.com' },
    });
    fireEvent.click(screen.getByTestId('checkbox-subscriber-consent'));
    fireEvent.submit(screen.getByTestId('input-subscriber-email').closest('form')!);

    expect(screen.getByTestId('status-subscriber')).toHaveTextContent(
      'We could not start your subscription. Please try again.',
    );
    fireEvent.click(screen.getByTestId('button-resend-subscriber-confirmation'));
    expect(screen.getByTestId('status-subscriber')).toHaveTextContent(
      'We could not request another confirmation. Please try again.',
    );
    expect(mocks.trackEvent).not.toHaveBeenCalled();
  });

  it('uses the server cohort when the browser clock is in a different UTC week', () => {
    vi.setSystemTime(new Date('2026-09-14T00:00:01Z'));
    mocks.createSubscriberMutate.mockImplementation((variables) => {
      mocks.createSubscriberOptions?.mutation?.onSuccess?.(
        { message: 'Check your inbox', cohort: '2026-09-07' },
        variables,
      );
    });
    mocks.resendMutate.mockImplementation(() => {
      mocks.resendOptions?.mutation?.onSuccess?.({
        message: 'Replacement sent',
        cohort: '2026-09-07',
      });
    });

    render(<NewsletterSignup />);
    fireEvent.change(screen.getByTestId('input-subscriber-email'), {
      target: { value: 'clock-skew@example.com' },
    });
    fireEvent.click(screen.getByTestId('checkbox-subscriber-consent'));
    fireEvent.submit(screen.getByTestId('input-subscriber-email').closest('form')!);

    expect(mocks.trackEvent).toHaveBeenCalledWith(
      'subscription_confirmation_requested',
      {
        location: 'homepage_newsletter',
        request_type: 'initial',
        cohort: '2026-09-07',
      },
    );

    act(() => {
      vi.advanceTimersByTime(FIFTEEN_MINUTES);
    });
    fireEvent.click(screen.getByTestId('button-resend-subscriber-confirmation'));

    expect(mocks.trackEvent).toHaveBeenLastCalledWith(
      'subscription_confirmation_replacement_requested',
      {
        location: 'homepage_newsletter',
        request_type: 'replacement',
        cohort: '2026-09-07',
      },
    );
  });
});
