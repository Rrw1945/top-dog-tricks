import {
  startApiServer,
  type ApiServerOptions,
} from "./apiServer";
import { parseHttpShutdownGraceMs } from "./lib/httpShutdown";
import { parseRecoveryShutdownGraceMs } from "./recoveryScheduler";

export function startConfiguredApiServer(
  options: Omit<
    ApiServerOptions,
    "recoveryShutdownGraceMs" | "httpShutdownGraceMs"
  > = {},
) {
  return startApiServer({
    ...options,
    recoveryShutdownGraceMs: parseRecoveryShutdownGraceMs(
      process.env["RECOVERY_SHUTDOWN_GRACE_MS"],
    ),
    httpShutdownGraceMs: parseHttpShutdownGraceMs(
      process.env["HTTP_SHUTDOWN_GRACE_MS"],
    ),
  });
}