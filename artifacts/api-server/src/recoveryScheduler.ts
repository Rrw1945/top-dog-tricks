export const SPOTLIGHT_NOTIFICATION_RECOVERY_INTERVAL_MS = 60 * 1_000;
export const WELCOME_EMAIL_RECOVERY_INTERVAL_MS = 60 * 1_000;
export const ANALYTICS_COVERAGE_NOTIFICATION_INTERVAL_MS = 5 * 60 * 1_000;
export const RECOVERY_SHUTDOWN_GRACE_MS = 30 * 1_000;
export const MIN_RECOVERY_SHUTDOWN_GRACE_MS = 100;
export const MAX_RECOVERY_SHUTDOWN_GRACE_MS = 5 * 60 * 1_000;
export const RECOVERY_SHUTDOWN_GRACE_ENV = "RECOVERY_SHUTDOWN_GRACE_MS";

export function validateRecoveryShutdownGraceMs(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < MIN_RECOVERY_SHUTDOWN_GRACE_MS ||
    value > MAX_RECOVERY_SHUTDOWN_GRACE_MS
  ) {
    throw new Error(
      `Invalid recovery shutdown grace period: ${String(value)}. ` +
        `Expected an integer from ${MIN_RECOVERY_SHUTDOWN_GRACE_MS} to ` +
        `${MAX_RECOVERY_SHUTDOWN_GRACE_MS} milliseconds.`,
    );
  }

  return value;
}

export function parseRecoveryShutdownGraceMs(
  rawValue: string | undefined,
): number {
  if (rawValue === undefined) return RECOVERY_SHUTDOWN_GRACE_MS;

  const trimmedValue = rawValue.trim();
  const value = trimmedValue === "" ? Number.NaN : Number(trimmedValue);
  try {
    return validateRecoveryShutdownGraceMs(value);
  } catch (error) {
    throw new Error(
      `${RECOVERY_SHUTDOWN_GRACE_ENV} must be an integer from ` +
        `${MIN_RECOVERY_SHUTDOWN_GRACE_MS} to ` +
        `${MAX_RECOVERY_SHUTDOWN_GRACE_MS} milliseconds; received ` +
        `"${rawValue}".`,
      { cause: error },
    );
  }
}

export type RecoveryJob = () => Promise<void>;
export type RecoveryErrorHandler = (error: unknown) => void;
export type RecoveryIntervalHandle = ReturnType<typeof setInterval>;
export type RecoverySetInterval = (
  callback: () => void,
  delayMs: number,
) => RecoveryIntervalHandle;
export type RecoveryClearInterval = (handle: RecoveryIntervalHandle) => void;
export type RecoveryDrainResult = "drained" | "timed_out";

export type SpotlightRecovery = (
  publicBaseUrl: string,
  logFailure: (
    error: unknown,
    submissionId?: number,
    subscriberId?: number,
  ) => void,
) => Promise<void>;

export type WelcomeRecovery = (
  publicBaseUrl: string,
  logOutcome: (
    outcome: "delivered" | "failed" | "permanently_failed",
    subscriberId: number,
    error?: string | null,
  ) => void,
) => Promise<void>;

export interface RecoveryLogger {
  error(details: unknown, message: string): void;
  info(details: unknown, message: string): void;
}

export interface RecoverySchedulerOptions {
  runSpotlightRecovery: RecoveryJob;
  runWelcomeRecovery: RecoveryJob;
  runAnalyticsCoverageNotification?: RecoveryJob;
  onSpotlightError: RecoveryErrorHandler;
  onWelcomeError: RecoveryErrorHandler;
  onAnalyticsCoverageError?: RecoveryErrorHandler;
  logger?: RecoveryLogger;
  setInterval?: RecoverySetInterval;
  clearInterval?: RecoveryClearInterval;
}

function reportRecoveryErrorFallback(message: string, details: unknown): void {
  try {
    console.error(message, details);
  } catch {
    // Reporting must not turn a handled recovery failure into a rejection.
  }
}

function clearRecoveryIntervals(
  cancelInterval: RecoveryClearInterval,
  timers: Array<RecoveryIntervalHandle | undefined>,
): unknown[] {
  const errors: unknown[] = [];
  for (const timer of timers) {
    if (timer === undefined) continue;
    try {
      cancelInterval(timer);
    } catch (error) {
      errors.push(error);
    }
  }
  return errors;
}

function reportTimerCleanupFailure(
  error: AggregateError,
  logger?: RecoveryLogger,
): void {
  const message = "Recovery scheduler interval cleanup failed";
  if (logger) {
    try {
      logger.error({ err: error }, message);
      return;
    } catch {
      // Logging failures must not interrupt recovery shutdown.
    }
  }
  try {
    console.error(message, error);
  } catch {
    // The final fallback must not interrupt recovery shutdown.
  }
}

function reportRecoveryError(
  recoveryName: "spotlight" | "welcome" | "analytics coverage notification",
  onError: RecoveryErrorHandler,
  error: unknown,
  logger?: RecoveryLogger,
): void {
  try {
    onError(error);
  } catch (reportingError) {
    const details = {
      recoveryError: error,
      reportingError,
    };
    const message = `Scheduled ${recoveryName} recovery error reporting failed`;
    if (logger) {
      try {
        logger.error(details, message);
      } catch (loggerError) {
        reportRecoveryErrorFallback(
          `${message}; structured logging failed`,
          { ...details, loggerError },
        );
      }
      return;
    }
    reportRecoveryErrorFallback(message, details);
  }
}

export function createRecoveryScheduler({
  runSpotlightRecovery: recoverSpotlight,
  runWelcomeRecovery: recoverWelcome,
  runAnalyticsCoverageNotification: notifyAnalyticsCoverage,
  onSpotlightError,
  onWelcomeError,
  onAnalyticsCoverageError = (error) => {
    console.error("Scheduled analytics coverage notification failed", error);
  },
  logger,
  setInterval: scheduleInterval = setInterval,
  clearInterval: cancelInterval = clearInterval,
}: RecoverySchedulerOptions) {
  let spotlightRecoveryRunning = false;
  let welcomeRecoveryRunning = false;
  let analyticsCoverageNotificationRunning = false;
  let acceptingRecovery = false;
  let recoveryGeneration = 0;
  let spotlightRecoveryTimer: RecoveryIntervalHandle | undefined;
  let welcomeRecoveryTimer: RecoveryIntervalHandle | undefined;
  let analyticsCoverageNotificationTimer: RecoveryIntervalHandle | undefined;
  const activeRecoveries = new Set<Promise<void>>();

  const runSpotlightRecovery = async (): Promise<void> => {
    if (!acceptingRecovery || spotlightRecoveryRunning) return;
    spotlightRecoveryRunning = true;
    try {
      await recoverSpotlight();
    } catch (error) {
      reportRecoveryError("spotlight", onSpotlightError, error, logger);
    } finally {
      spotlightRecoveryRunning = false;
    }
  };

  const runWelcomeRecovery = async (): Promise<void> => {
    if (!acceptingRecovery || welcomeRecoveryRunning) return;
    welcomeRecoveryRunning = true;
    try {
      await recoverWelcome();
    } catch (error) {
      reportRecoveryError("welcome", onWelcomeError, error, logger);
    } finally {
      welcomeRecoveryRunning = false;
    }
  };

  const runAnalyticsCoverageNotification = async (): Promise<void> => {
    if (
      !acceptingRecovery
      || analyticsCoverageNotificationRunning
      || !notifyAnalyticsCoverage
    ) {
      return;
    }
    analyticsCoverageNotificationRunning = true;
    try {
      await notifyAnalyticsCoverage();
    } catch (error) {
      reportRecoveryError(
        "analytics coverage notification",
        onAnalyticsCoverageError,
        error,
        logger,
      );
    } finally {
      analyticsCoverageNotificationRunning = false;
    }
  };

  const trackRecovery = (run: () => Promise<void>): void => {
    const recovery = run();
    activeRecoveries.add(recovery);
    recovery.then(
      () => activeRecoveries.delete(recovery),
      () => activeRecoveries.delete(recovery),
    );
  };

  const start = (): void => {
    if (acceptingRecovery) return;
    const generation = ++recoveryGeneration;
    let spotlightTimer: RecoveryIntervalHandle | undefined;
    let welcomeTimer: RecoveryIntervalHandle | undefined;
    let analyticsCoverageTimer: RecoveryIntervalHandle | undefined;

    try {
      spotlightTimer = scheduleInterval(
        () => {
          if (generation === recoveryGeneration) {
            trackRecovery(runSpotlightRecovery);
          }
        },
        SPOTLIGHT_NOTIFICATION_RECOVERY_INTERVAL_MS,
      );
      welcomeTimer = scheduleInterval(
        () => {
          if (generation === recoveryGeneration) {
            trackRecovery(runWelcomeRecovery);
          }
        },
        WELCOME_EMAIL_RECOVERY_INTERVAL_MS,
      );
      if (notifyAnalyticsCoverage) {
        analyticsCoverageTimer = scheduleInterval(
          () => {
            if (generation === recoveryGeneration) {
              trackRecovery(runAnalyticsCoverageNotification);
            }
          },
          ANALYTICS_COVERAGE_NOTIFICATION_INTERVAL_MS,
        );
      }
    } catch (error) {
      const cleanupErrors = clearRecoveryIntervals(cancelInterval, [
        spotlightTimer,
        welcomeTimer,
        analyticsCoverageTimer,
      ]);
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          "Recovery scheduler startup failed and timer cleanup was incomplete",
          { cause: error },
        );
      }
      throw error;
    }

    spotlightRecoveryTimer = spotlightTimer;
    welcomeRecoveryTimer = welcomeTimer;
    analyticsCoverageNotificationTimer = analyticsCoverageTimer;
    acceptingRecovery = true;
    trackRecovery(runSpotlightRecovery);
    trackRecovery(runWelcomeRecovery);
    if (notifyAnalyticsCoverage) {
      trackRecovery(runAnalyticsCoverageNotification);
    }
  };

  const stopIntervals = (): unknown[] => {
    acceptingRecovery = false;
    recoveryGeneration += 1;

    const timers = [
      spotlightRecoveryTimer,
      welcomeRecoveryTimer,
      analyticsCoverageNotificationTimer,
    ];
    spotlightRecoveryTimer = undefined;
    welcomeRecoveryTimer = undefined;
    analyticsCoverageNotificationTimer = undefined;
    return clearRecoveryIntervals(cancelInterval, timers);
  };

  const stop = (): void => {
    const cleanupErrors = stopIntervals();
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        cleanupErrors,
        "Failed to clear one or more recovery scheduler intervals",
      );
    }
  };

  const stopAndDrain = async (
    graceMs = RECOVERY_SHUTDOWN_GRACE_MS,
  ): Promise<RecoveryDrainResult> => {
    const cleanupErrors = stopIntervals();
    if (cleanupErrors.length > 0) {
      reportTimerCleanupFailure(
        new AggregateError(
          cleanupErrors,
          "Failed to clear one or more recovery scheduler intervals",
        ),
        logger,
      );
    }

    const recoveries = [...activeRecoveries];
    if (recoveries.length === 0) return "drained";

    const drain = Promise.allSettled(recoveries).then(() => "drained" as const);
    if (graceMs <= 0) return "timed_out";

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<RecoveryDrainResult>((resolve) => {
      timeout = setTimeout(() => resolve("timed_out"), graceMs);
    });
    const result = await Promise.race([drain, deadline]);
    if (timeout !== undefined) clearTimeout(timeout);
    return result;
  };

  return {
    runSpotlightRecovery,
    runWelcomeRecovery,
    start,
    stop,
    stopAndDrain,
  };
}

export interface ApiRecoverySchedulerOptions {
  recoverSpotlightNotifications: SpotlightRecovery;
  recoverWelcomeEmails: WelcomeRecovery;
  getNewsletterFunnelReport?: () => Promise<import("./lib/newsletterFunnelAnalytics").NewsletterFunnelReport>;
  notifyNewsletterCoverageRegressions?: (
    report: import("./lib/newsletterFunnelAnalytics").NewsletterFunnelReport,
    dependencies?: import("./lib/newsletterFunnelNotifications").NewsletterFunnelNotificationDependencies,
  ) => Promise<boolean>;
  getPublicBaseUrl: (host: string | undefined) => string;
  logger: RecoveryLogger;
  setInterval?: RecoverySetInterval;
  clearInterval?: RecoveryClearInterval;
}

export function createApiRecoveryScheduler({
  recoverSpotlightNotifications,
  recoverWelcomeEmails,
  getNewsletterFunnelReport = async () =>
    (await import("./lib/newsletterFunnelAnalytics")).getNewsletterFunnelReport(),
  notifyNewsletterCoverageRegressions = async (report, dependencies) =>
    (await import("./lib/newsletterFunnelNotifications"))
      .notifyNewsletterCoverageRegressions(report, dependencies),
  getPublicBaseUrl,
  logger,
  setInterval,
  clearInterval,
}: ApiRecoverySchedulerOptions) {
  return createRecoveryScheduler({
    runSpotlightRecovery: async () => {
      await recoverSpotlightNotifications(
        getPublicBaseUrl(undefined),
        (error, submissionId, subscriberId) => {
          logger.error(
            { err: error, submissionId, subscriberId },
            "Scheduled spotlight notification recovery failed",
          );
        },
      );
    },
    onSpotlightError: (error) => {
      logger.error(
        { err: error },
        "Scheduled spotlight notification recovery failed",
      );
    },
    runWelcomeRecovery: async () => {
      await recoverWelcomeEmails(
        getPublicBaseUrl(undefined),
        (outcome, subscriberId, error) => {
          const details = { outcome, subscriberId, error };
          if (outcome === "delivered") {
            logger.info(details, "Scheduled welcome email recovery succeeded");
          } else {
            logger.error(details, "Scheduled welcome email recovery failed");
          }
        },
      );
    },
    onWelcomeError: (error) => {
      logger.error({ err: error }, "Scheduled welcome email recovery failed");
    },
    runAnalyticsCoverageNotification: async () => {
      if (!process.env["CLICKHOUSE_URL"]?.trim()) return;
      const report = await getNewsletterFunnelReport();
      await notifyNewsletterCoverageRegressions(report, {
        onProviderFailure: (channel, error) => {
          logger.error(
            { err: error, channel },
            "Scheduled newsletter funnel coverage provider failed",
          );
        },
      });
    },
    onAnalyticsCoverageError: (error) => {
      logger.error(
        { err: error },
        "Scheduled analytics coverage notification failed",
      );
    },
    logger,
    setInterval,
    clearInterval,
  });
}
