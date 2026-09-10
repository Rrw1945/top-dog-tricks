import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { handleTemporaryDirectoryCleanupFailure } from "./temporaryDirectoryCleanup";

const options = {
  workingDir: "/tmp/media-job-test",
  cleanupErrorName: "MediaJobCleanupError",
  contextualMessage: "Failed to clean up media job temporary directory",
  logMessage: "Failed to clean up media job temporary directory",
};

describe("handleTemporaryDirectoryCleanupFailure", () => {
  it("throws a contextual error when cleanup is the only failure", () => {
    const cleanupCause = new Error("temporary directory is busy");

    assert.throws(
      () =>
        handleTemporaryDirectoryCleanupFailure({
          ...options,
          operationError: undefined,
          cleanupCause,
        }),
      (error: Error) => {
        assert.equal(error.name, "MediaJobCleanupError");
        assert.equal(
          error.message,
          "Failed to clean up media job temporary directory: /tmp/media-job-test",
        );
        assert.equal(error.cause, cleanupCause);
        return true;
      },
    );
  });

  it("preserves the operation error and attaches and logs cleanup context", () => {
    const operationError = new Error("media job failed");
    const cleanupCause = new Error("temporary directory is busy");
    const loggedErrors: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => loggedErrors.push(args);

    try {
      handleTemporaryDirectoryCleanupFailure({
        ...options,
        operationError,
        cleanupCause,
      });
    } finally {
      console.error = originalConsoleError;
    }

    const contextualCleanupError = (
      operationError as Error & { cleanupError?: Error }
    ).cleanupError;
    assert.equal(contextualCleanupError?.name, "MediaJobCleanupError");
    assert.equal(
      contextualCleanupError?.message,
      "Failed to clean up media job temporary directory: /tmp/media-job-test",
    );
    assert.equal(contextualCleanupError?.cause, cleanupCause);
    assert.deepEqual(loggedErrors, [[options.logMessage, contextualCleanupError]]);
  });

  it("does not replace a non-Error operation failure with the cleanup failure", () => {
    const cleanupCause = new Error("temporary directory is busy");
    const loggedErrors: unknown[][] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => loggedErrors.push(args);

    try {
      assert.doesNotThrow(() =>
        handleTemporaryDirectoryCleanupFailure({
          ...options,
          operationError: "media job failed",
          cleanupCause,
        }),
      );
    } finally {
      console.error = originalConsoleError;
    }

    const contextualCleanupError = loggedErrors[0]?.[1] as Error;
    assert.equal(contextualCleanupError.name, "MediaJobCleanupError");
    assert.equal(contextualCleanupError.cause, cleanupCause);
    assert.deepEqual(loggedErrors, [[options.logMessage, contextualCleanupError]]);
  });
});