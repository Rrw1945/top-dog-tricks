import type { Server } from "node:http";

export const HTTP_SHUTDOWN_GRACE_MS = 10 * 1_000;
export const MIN_HTTP_SHUTDOWN_GRACE_MS = 100;
export const MAX_HTTP_SHUTDOWN_GRACE_MS = 5 * 60 * 1_000;
export const HTTP_SHUTDOWN_GRACE_ENV = "HTTP_SHUTDOWN_GRACE_MS";

export function validateHttpShutdownGraceMs(value: number): number {
  if (
    !Number.isInteger(value) ||
    value < MIN_HTTP_SHUTDOWN_GRACE_MS ||
    value > MAX_HTTP_SHUTDOWN_GRACE_MS
  ) {
    throw new Error(
      `Invalid HTTP shutdown grace period: ${String(value)}. ` +
        `Expected an integer from ${MIN_HTTP_SHUTDOWN_GRACE_MS} to ` +
        `${MAX_HTTP_SHUTDOWN_GRACE_MS} milliseconds.`,
    );
  }

  return value;
}

export function parseHttpShutdownGraceMs(
  rawValue: string | undefined,
): number {
  if (rawValue === undefined) return HTTP_SHUTDOWN_GRACE_MS;

  const trimmedValue = rawValue.trim();
  const value = trimmedValue === "" ? Number.NaN : Number(trimmedValue);
  try {
    return validateHttpShutdownGraceMs(value);
  } catch (error) {
    throw new Error(
      `${HTTP_SHUTDOWN_GRACE_ENV} must be an integer from ` +
        `${MIN_HTTP_SHUTDOWN_GRACE_MS} to ` +
        `${MAX_HTTP_SHUTDOWN_GRACE_MS} milliseconds; received ` +
        `"${rawValue}".`,
      { cause: error },
    );
  }
}

export type HttpShutdownResult = "closed" | "timed_out" | "error";

export interface HttpShutdownLogger {
  error(details: unknown, message: string): void;
  info(details: unknown, message: string): void;
}

type ClosableHttpServer = Pick<
  Server,
  "close" | "closeAllConnections"
> & {
  getConnections(
    callback: (error: Error | null, count: number) => void,
  ): void;
};

export function closeHttpServer(
  server: ClosableHttpServer,
  graceMs: number,
  logger: HttpShutdownLogger,
): Promise<HttpShutdownResult> {
  return new Promise((resolve) => {
    let settled = false;
    let forcing = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const finish = (result: HttpShutdownResult): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      resolve(result);
    };

    const forceClose = (): void => {
      if (settled || forcing) return;
      forcing = true;

      const forceCloseConnections = (connectionCount: number | null): void => {
        logger.error(
          { graceMs, connectionCount },
          "HTTP server did not close before shutdown grace period; forcing connections closed",
        );

        try {
          server.closeAllConnections();
        } catch (error) {
          logger.error({ err: error }, "Error force-closing HTTP connections");
        } finally {
          finish("timed_out");
        }
      };

      try {
        server.getConnections((error, connectionCount) => {
          if (error) {
            logger.error(
              { err: error },
              "Error counting active HTTP connections",
            );
            forceCloseConnections(null);
            return;
          }

          forceCloseConnections(connectionCount);
        });
      } catch (error) {
        logger.error({ err: error }, "Error counting active HTTP connections");
        forceCloseConnections(null);
      }
    };

    if (graceMs > 0) {
      timeout = setTimeout(forceClose, graceMs);
    }

    try {
      server.close((error) => {
        if (settled || forcing) return;
        if (error) {
          logger.error({ err: error }, "Error closing HTTP server");
          finish("error");
          return;
        }

        try {
          logger.info(
            { graceMs },
            "HTTP server closed cleanly before shutdown grace period",
          );
        } catch {
          // A diagnostic failure must not escape the asynchronous close callback.
        } finally {
          finish("closed");
        }
      });

      if (graceMs <= 0) forceClose();
    } catch (error) {
      logger.error({ err: error }, "Error closing HTTP server");
      finish("error");
    }
  });
}