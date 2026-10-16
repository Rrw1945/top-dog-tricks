export function describeError(error) {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

export function createCleanupFailure(label, error) {
  return new Error(
    `${label} failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
    { cause: error },
  );
}

export function createCleanupAggregateError(message, failures) {
  const aggregateError = new AggregateError(failures, message);
  aggregateError.message = `${message}\n${describeCleanupFailures(
    aggregateError,
  )}`;
  return aggregateError;
}

export function describeCleanupFailures(error) {
  if (error instanceof AggregateError) {
    return error.errors
      .flatMap((cause) => describeCleanupFailures(cause))
      .join("\n");
  }

  if (error instanceof Error && error.cause) {
    return [
      `- ${error.message}`,
      ...describeError(error.cause)
        .split("\n")
        .map((line) => `  ${line}`),
    ].join("\n");
  }

  return `- ${describeError(error)}`;
}
