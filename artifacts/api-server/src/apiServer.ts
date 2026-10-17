import app from "./app";
import { getPublicBaseUrl as defaultGetPublicBaseUrl } from "./lib/integrations";
import {
  closeHttpServer,
  HTTP_SHUTDOWN_GRACE_MS,
  validateHttpShutdownGraceMs,
  type HttpShutdownResult,
} from "./lib/httpShutdown";
import { logger as defaultLogger } from "./lib/logger";
import {
  createApiRecoveryScheduler,
  RECOVERY_SHUTDOWN_GRACE_MS,
  validateRecoveryShutdownGraceMs,
  type RecoveryLogger,
  type ApiRecoverySchedulerOptions,
} from "./recoveryScheduler";
import { recoverWelcomeEmails } from "./routes/engagement";
import { recoverSpotlightNotifications } from "./routes/submissions";

export interface ApiServerOptions {
  getNewsletterFunnelReport?: ApiRecoverySchedulerOptions["getNewsletterFunnelReport"];
  notifyNewsletterCoverageRegressions?: ApiRecoverySchedulerOptions["notifyNewsletterCoverageRegressions"];
  recoverSpotlightNotifications?: typeof recoverSpotlightNotifications;
  recoverWelcomeEmails?: typeof recoverWelcomeEmails;
  getPublicBaseUrl?: typeof defaultGetPublicBaseUrl;
  logger?: RecoveryLogger;
  recoveryShutdownGraceMs?: number;
  httpShutdownGraceMs?: number;
  onListening?: () => void;
}

export function startApiServer({
  recoverSpotlightNotifications:
    recoverSpotlight = recoverSpotlightNotifications,
  recoverWelcomeEmails: recoverWelcome = recoverWelcomeEmails,
  getNewsletterFunnelReport,
  notifyNewsletterCoverageRegressions,
  getPublicBaseUrl = defaultGetPublicBaseUrl,
  logger = defaultLogger,
  recoveryShutdownGraceMs = RECOVERY_SHUTDOWN_GRACE_MS,
  httpShutdownGraceMs = HTTP_SHUTDOWN_GRACE_MS,
  onListening,
}: ApiServerOptions = {}) {
  const rawPort = process.env["PORT"];

  if (!rawPort) {
    throw new Error(
      "PORT environment variable is required but was not provided.",
    );
  }

  const port = Number(rawPort);

  if (Number.isNaN(port) || port <= 0) {
    throw new Error(`Invalid PORT value: "${rawPort}"`);
  }

  const effectiveRecoveryShutdownGraceMs = validateRecoveryShutdownGraceMs(
    recoveryShutdownGraceMs,
  );
  const effectiveHttpShutdownGraceMs = validateHttpShutdownGraceMs(
    httpShutdownGraceMs,
  );

  let shuttingDown = false;
  let recoveryScheduler:
    ReturnType<typeof createApiRecoveryScheduler> | undefined;

  const server = app.listen(port, (err) => {
    if (err) {
      logger.error({ err }, "Error listening on port");
      process.exit(1);
    }

    if (shuttingDown || recoveryScheduler !== undefined) return;

    logger.info({ port }, "Server listening");
    onListening?.();

    recoveryScheduler = createApiRecoveryScheduler({
      recoverSpotlightNotifications: recoverSpotlight,
      recoverWelcomeEmails: recoverWelcome,
      getNewsletterFunnelReport,
      notifyNewsletterCoverageRegressions,
      getPublicBaseUrl,
      logger,
    });

    recoveryScheduler.start();
  });

  server.on("request", (request) => {
    request.once("aborted", () => {
      if (shuttingDown) server.closeIdleConnections();
    });
  });

  const closeHttpServerWhenReady = (): Promise<HttpShutdownResult> => {
    if (server.listening) {
      return closeHttpServer(server, effectiveHttpShutdownGraceMs, logger);
    }

    return new Promise((resolve) => {
      const cleanup = (): void => {
        server.off("listening", onListening);
        server.off("error", onError);
      };
      const onListening = (): void => {
        cleanup();
        void closeHttpServer(server, effectiveHttpShutdownGraceMs, logger).then(
          resolve,
        );
      };
      const onError = (error: Error): void => {
        cleanup();
        logger.error({ err: error }, "Error listening on port");
        resolve("error");
      };

      server.once("listening", onListening);
      server.once("error", onError);

      if (server.listening) onListening();
    });
  };

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    const scheduler = recoveryScheduler;
    logger.info(
      {
        signal,
        recoveryGraceMs: effectiveRecoveryShutdownGraceMs,
        httpGraceMs: effectiveHttpShutdownGraceMs,
      },
      "Shutting down server",
    );
    const drain =
      scheduler?.stopAndDrain(effectiveRecoveryShutdownGraceMs) ??
      Promise.resolve("drained" as const);

    const httpShutdown = closeHttpServerWhenReady();

    void Promise.all([drain, httpShutdown]).then(
      ([recoveryResult, httpShutdownResult]) => {
        removeSignalHandlers();
        if (recoveryResult === "timed_out") {
          logger.error(
            { graceMs: effectiveRecoveryShutdownGraceMs },
            "Recovery deliveries did not finish before shutdown grace period",
          );
        }
        if (httpShutdownResult === "error") {
          process.exitCode = 1;
        }
        if (
          recoveryResult === "timed_out" ||
          httpShutdownResult === "timed_out"
        ) {
          process.exit(httpShutdownResult === "error" ? 1 : 0);
        }
      },
    );
  };

  const handleSigint = (): void => shutdown("SIGINT");
  const handleSigterm = (): void => shutdown("SIGTERM");
  process.on("SIGINT", handleSigint);
  process.on("SIGTERM", handleSigterm);

  const removeSignalHandlers = (): void => {
    process.removeListener("SIGINT", handleSigint);
    process.removeListener("SIGTERM", handleSigterm);
  };

  return { server, shutdown };
}
