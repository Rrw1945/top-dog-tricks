export const SPOTLIGHT_NOTIFICATION_RECOVERY_INTERVAL_MS = 60 * 1_000;
export const WELCOME_EMAIL_RECOVERY_INTERVAL_MS = 60 * 1_000;

export type RecoveryJob = () => Promise<void>;
export type RecoveryErrorHandler = (error: unknown) => void;
export type RecoveryIntervalHandle = ReturnType<typeof setInterval>;
export type RecoverySetInterval = (
  callback: () => void,
  delayMs: number,
) => RecoveryIntervalHandle;
export type RecoveryClearInterval = (handle: RecoveryIntervalHandle) => void;

export interface RecoverySchedulerOptions {
  runSpotlightRecovery: RecoveryJob;
  runWelcomeRecovery: RecoveryJob;
  onSpotlightError: RecoveryErrorHandler;
  onWelcomeError: RecoveryErrorHandler;
  setInterval?: RecoverySetInterval;
  clearInterval?: RecoveryClearInterval;
}


export function createRecoveryScheduler({
  runSpotlightRecovery: recoverSpotlight,
  runWelcomeRecovery: recoverWelcome,
  onSpotlightError,
  onWelcomeError,
  setInterval: scheduleInterval = setInterval,
  clearInterval: cancelInterval = clearInterval,
}: RecoverySchedulerOptions) {
  let spotlightRecoveryRunning = false;
  let welcomeRecoveryRunning = false;
  let spotlightRecoveryTimer: RecoveryIntervalHandle | undefined;
  let welcomeRecoveryTimer: RecoveryIntervalHandle | undefined;

  const runSpotlightRecovery = async (): Promise<void> => {
    if (spotlightRecoveryRunning) return;
    spotlightRecoveryRunning = true;
    try {
      await recoverSpotlight();
    } catch (error) {
      onSpotlightError(error);
    } finally {
      spotlightRecoveryRunning = false;
    }
  };

  const runWelcomeRecovery = async (): Promise<void> => {
    if (welcomeRecoveryRunning) return;
    welcomeRecoveryRunning = true;
    try {
      await recoverWelcome();
    } catch (error) {
      onWelcomeError(error);
    } finally {
      welcomeRecoveryRunning = false;
    }
  };

  const start = (): void => {
    void runSpotlightRecovery();
    void runWelcomeRecovery();
    spotlightRecoveryTimer = scheduleInterval(
      () => void runSpotlightRecovery(),
      SPOTLIGHT_NOTIFICATION_RECOVERY_INTERVAL_MS,
    );
    welcomeRecoveryTimer = scheduleInterval(
      () => void runWelcomeRecovery(),
      WELCOME_EMAIL_RECOVERY_INTERVAL_MS,
    );
  };

  const stop = (): void => {
    if (spotlightRecoveryTimer !== undefined) {
      cancelInterval(spotlightRecoveryTimer);
      spotlightRecoveryTimer = undefined;
    }

    if (welcomeRecoveryTimer !== undefined) {
      cancelInterval(welcomeRecoveryTimer);
      welcomeRecoveryTimer = undefined;
    }
  };

  return {
    runSpotlightRecovery,
    runWelcomeRecovery,
    start,
    stop,
  };
}