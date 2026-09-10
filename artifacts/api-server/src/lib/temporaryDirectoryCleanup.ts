export type ErrorWithCleanupFailure = Error & {
  cleanupError?: Error;
};

type HandleTemporaryDirectoryCleanupFailureOptions = {
  operationError: unknown;
  cleanupCause: unknown;
  workingDir: string;
  cleanupErrorName: string;
  contextualMessage: string;
  logMessage: string;
};

export function handleTemporaryDirectoryCleanupFailure({
  operationError,
  cleanupCause,
  workingDir,
  cleanupErrorName,
  contextualMessage,
  logMessage,
}: HandleTemporaryDirectoryCleanupFailureOptions): never | void {
  const contextualCleanupError = new Error(
    `${contextualMessage}: ${workingDir}`,
    { cause: cleanupCause },
  );
  contextualCleanupError.name = cleanupErrorName;

  if (operationError === undefined) {
    throw contextualCleanupError;
  }

  if (operationError instanceof Error) {
    (operationError as ErrorWithCleanupFailure).cleanupError =
      contextualCleanupError;
  }
  console.error(logMessage, contextualCleanupError);
}