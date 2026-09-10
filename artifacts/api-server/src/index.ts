import app from "./app";
import { getPublicBaseUrl } from "./lib/integrations";
import { logger } from "./lib/logger";
import { createRecoveryScheduler } from "./recoveryScheduler";
import { recoverWelcomeEmails } from "./routes/engagement";
import { recoverSpotlightNotifications } from "./routes/submissions";

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

let shuttingDown = false;
let recoveryScheduler: ReturnType<typeof createRecoveryScheduler> | undefined;

const server = app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  if (shuttingDown) return;

  logger.info({ port }, "Server listening");

  recoveryScheduler = createRecoveryScheduler({
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
  });

  recoveryScheduler.start();
});

const shutdown = (signal: NodeJS.Signals): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  recoveryScheduler?.stop();
  logger.info({ signal }, "Shutting down server");
  server.close((err) => {
    if (err) {
      logger.error({ err }, "Error closing server");
      process.exitCode = 1;
    }
  });
};

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));
