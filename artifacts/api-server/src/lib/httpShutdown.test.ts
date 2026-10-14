import assert from "node:assert/strict";
import { createServer, request, type Server } from "node:http";
import { once } from "node:events";
import { connect } from "node:net";
import test from "node:test";

import {
  closeHttpServer,
  HTTP_SHUTDOWN_GRACE_ENV,
  HTTP_SHUTDOWN_GRACE_MS,
  MAX_HTTP_SHUTDOWN_GRACE_MS,
  MIN_HTTP_SHUTDOWN_GRACE_MS,
  parseHttpShutdownGraceMs,
  type HttpShutdownLogger,
} from "./httpShutdown";

test("HTTP shutdown grace configuration uses the safe default when unset", () => {
  assert.equal(parseHttpShutdownGraceMs(undefined), HTTP_SHUTDOWN_GRACE_MS);
});

test("HTTP shutdown grace configuration accepts bounded whole milliseconds", () => {
  assert.equal(
    parseHttpShutdownGraceMs(` ${MIN_HTTP_SHUTDOWN_GRACE_MS} `),
    MIN_HTTP_SHUTDOWN_GRACE_MS,
  );
  assert.equal(
    parseHttpShutdownGraceMs(String(MAX_HTTP_SHUTDOWN_GRACE_MS)),
    MAX_HTTP_SHUTDOWN_GRACE_MS,
  );
});

test("HTTP shutdown grace configuration rejects unsafe values", () => {
  for (const rawValue of [
    "",
    "0",
    String(MIN_HTTP_SHUTDOWN_GRACE_MS - 1),
    "100.5",
    String(MAX_HTTP_SHUTDOWN_GRACE_MS + 1),
    "not-a-number",
  ]) {
    assert.throws(
      () => parseHttpShutdownGraceMs(rawValue),
      new RegExp(`${HTTP_SHUTDOWN_GRACE_ENV}.*${rawValue || '""'}`),
    );
  }
});

function createLogger() {
  const entries: Array<{
    level: "error" | "info";
    details: unknown;
    message: string;
  }> = [];
  const logger: HttpShutdownLogger = {
    error: (details, message) =>
      entries.push({ level: "error", details, message }),
    info: (details, message) =>
      entries.push({ level: "info", details, message }),
  };
  return { entries, logger };
}

async function getFreePort(): Promise<number> {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = probe.address();
  assert(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

test("API shutdown does not force connections after a client aborts a request", async () => {
  const port = await getFreePort();
  const previousPort = process.env["PORT"];
  process.env["PORT"] = String(port);

  const { entries, logger: baseLogger } = createLogger();
  let closeIdleConnectionsCalls = 0;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const logger = {
    error: baseLogger.error,
    info: (details: unknown, message: string) => {
      baseLogger.info(details, message);
      if (message === "HTTP server closed cleanly before shutdown grace period") {
        resolveClosed();
      }
    },
  };
  let clientRequest: ReturnType<typeof request> | undefined;
  let apiServer:
    | {
        server: Server;
        shutdown: (signal: NodeJS.Signals) => void;
      }
    | undefined;

  try {
    process.env.NODE_ENV = "production";
    const { startApiServer } = await import("../apiServer");
    let resolveListening!: () => void;
    const listening = new Promise<void>((resolve) => {
      resolveListening = resolve;
    });
    apiServer = startApiServer({
      recoverSpotlightNotifications: async () => {},
      recoverWelcomeEmails: async () => {},
      getPublicBaseUrl: () => "https://top-dog-tricks.example",
      logger,
      recoveryShutdownGraceMs: 100,
      httpShutdownGraceMs: 200,
      onListening: resolveListening,
    });
    await listening;

    const originalCloseIdleConnections = apiServer.server.closeIdleConnections.bind(
      apiServer.server,
    );
    apiServer.server.closeIdleConnections = () => {
      closeIdleConnectionsCalls += 1;
      originalCloseIdleConnections();
    };

    const requestStarted = once(apiServer.server, "request");
    clientRequest = request({
      host: "127.0.0.1",
      path: "/api/submissions",
      port,
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": "10000",
      },
    });
    clientRequest.on("error", () => {});
    clientRequest.write('{"ownerName":"disconnected');
    await requestStarted;

    apiServer.shutdown("SIGTERM");
    clientRequest.destroy();

    await Promise.race([
      closed,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("HTTP shutdown did not finish")), 1_000),
      ),
    ]);

    assert.equal(closeIdleConnectionsCalls, 1);
    assert.equal(
      entries.some(
        ({ message }) =>
          message ===
          "HTTP server did not close before shutdown grace period; forcing connections closed",
      ),
      false,
    );
  } finally {
    clientRequest?.destroy();
    apiServer?.shutdown("SIGTERM");
    if (previousPort === undefined) delete process.env["PORT"];
    else process.env["PORT"] = previousPort;
  }
});

test("HTTP shutdown lets an active request finish on a real server", async () => {
  const { entries, logger } = createLogger();
  let requestStarted!: () => void;
  const requestIsActive = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  let forcedConnections = 0;
  const server = createServer((_request, response) => {
    requestStarted();
    response.setHeader("Connection", "close");
    setTimeout(() => response.end("finished"), 25);
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  const address = server.address();
  assert(address && typeof address !== "string");

  try {
    const responsePromise = new Promise<{
      body: string;
      statusCode: number | undefined;
    }>((resolve, reject) => {
      const clientRequest = request(
        {
          host: "127.0.0.1",
          path: "/active-request",
          port: address.port,
        },
        (response) => {
          const chunks: string[] = [];
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => chunks.push(chunk));
          response.on("end", () => {
            resolve({
              body: chunks.join(""),
              statusCode: response.statusCode,
            });
          });
          response.on("error", reject);
        },
      );
      clientRequest.on("error", reject);
      clientRequest.end();
    });

    await requestIsActive;

    const shutdownResult = await closeHttpServer(
      {
        close: (callback) => server.close(callback),
        closeAllConnections: () => {
          forcedConnections += 1;
          server.closeAllConnections();
        },
        getConnections: (callback) => server.getConnections(callback),
      },
      200,
      logger,
    );
    const response = await responsePromise;

    assert.equal(shutdownResult, "closed");
    assert.equal(forcedConnections, 0);
    assert.deepEqual(response, { body: "finished", statusCode: 200 });
    assert.deepEqual(
      entries.map(({ level, message }) => [level, message]),
      [["info", "HTTP server closed cleanly before shutdown grace period"]],
    );
  } finally {
    server.closeAllConnections();
  }
});


test("HTTP shutdown waits for a clean close and does not force connections", async () => {
  const { entries, logger } = createLogger();
  let forcedConnections = 0;
  let countedConnections = 0;

  const result = await closeHttpServer(
    {
      close: (callback) => {
        setTimeout(() => callback?.(), 5);
        return undefined as never;
      },
      closeAllConnections: () => {
        forcedConnections += 1;
      },
      getConnections: (callback) => {
        countedConnections += 1;
        callback(null, 4);
      },
    },
    100,
    logger,
  );

  assert.equal(result, "closed");
  assert.equal(forcedConnections, 0);
  assert.equal(countedConnections, 0);
  assert.deepEqual(
    entries.map(({ level, message }) => [level, message]),
    [["info", "HTTP server closed cleanly before shutdown grace period"]],
  );
});

test("HTTP shutdown settles cleanly when its success logger throws", { timeout: 1_000 }, async () => {
  const { entries, logger } = createLogger();
  let closeCallback: ((error?: Error) => void) | undefined;
  let forcedConnections = 0;
  let countedConnections = 0;

  const shutdown = closeHttpServer(
    {
      close: (callback) => {
        closeCallback = callback;
        return undefined as never;
      },
      closeAllConnections: () => {
        forcedConnections += 1;
      },
      getConnections: (callback) => {
        countedConnections += 1;
        callback(null, 0);
      },
    },
    100,
    {
      error: logger.error,
      info: (details, message) => {
        logger.info(details, message);
        throw new Error("success logger failed");
      },
    },
  );

  // Invoke after close() returns, outside its synchronous try/catch.
  assert.ok(closeCallback);
  assert.doesNotThrow(() => closeCallback!());
  assert.equal(await shutdown, "closed");
  assert.equal(forcedConnections, 0);
  assert.equal(countedConnections, 0);
  assert.deepEqual(entries, [
    {
      level: "info",
      details: { graceMs: 100 },
      message: "HTTP server closed cleanly before shutdown grace period",
    },
  ]);
});

test("HTTP shutdown reports a close callback error without forcing connections", async () => {
  const { entries, logger } = createLogger();
  const server = createServer();
  let forcedConnections = 0;
  let countedConnections = 0;

  const result = await closeHttpServer(
    {
      close: (callback) => server.close(callback),
      closeAllConnections: () => {
        forcedConnections += 1;
      },
      getConnections: (callback) => {
        countedConnections += 1;
        callback(null, 0);
      },
    },
    100,
    logger,
  );

  assert.equal(result, "error");
  assert.equal(forcedConnections, 0);
  assert.equal(countedConnections, 0);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.level, "error");
  assert.equal(entries[0]?.message, "Error closing HTTP server");
  assert.equal(
    (entries[0]?.details as { err?: NodeJS.ErrnoException }).err?.code,
    "ERR_SERVER_NOT_RUNNING",
  );
});

test("HTTP shutdown reports a synchronous close exception without forcing connections", async () => {
  const { entries, logger } = createLogger();
  const closeError = new Error("close failed synchronously");
  let forcedConnections = 0;
  let countedConnections = 0;

  const result = await closeHttpServer(
    {
      close: () => {
        throw closeError;
      },
      closeAllConnections: () => {
        forcedConnections += 1;
      },
      getConnections: () => {
        countedConnections += 1;
      },
    },
    100,
    logger,
  );

  assert.equal(result, "error");
  assert.equal(forcedConnections, 0);
  assert.equal(countedConnections, 0);
  assert.deepEqual(entries, [
    {
      level: "error",
      details: { err: closeError },
      message: "Error closing HTTP server",
    },
  ]);
});

test("HTTP shutdown force-closes lingering connections after the grace period", async () => {
  const { entries, logger } = createLogger();
  let forcedConnections = 0;

  const result = await closeHttpServer(
    {
      close: () => undefined as never,
      closeAllConnections: () => {
        forcedConnections += 1;
      },
      getConnections: (callback) => callback(null, 3),
    },
    0,
    logger,
  );

  assert.equal(result, "timed_out");
  assert.equal(forcedConnections, 1);
  assert.deepEqual(entries[0]?.details, { graceMs: 0, connectionCount: 3 });
  assert.deepEqual(
    entries.map(({ level, message }) => [level, message]),
    [
      [
        "error",
        "HTTP server did not close before shutdown grace period; forcing connections closed",
      ],
    ],
  );
});

test("HTTP shutdown stays timed out and reports an error when force-closing throws", async () => {
  const { entries, logger } = createLogger();
  const forceCloseError = new Error("socket closure failed");
  let forcedConnections = 0;

  const result = await closeHttpServer(
    {
      close: () => undefined as never,
      closeAllConnections: () => {
        forcedConnections += 1;
        throw forceCloseError;
      },
      getConnections: (callback) => callback(null, 2),
    },
    0,
    logger,
  );

  assert.equal(result, "timed_out");
  assert.equal(forcedConnections, 1);
  assert.deepEqual(
    entries.map(({ level, details, message }) => ({ level, details, message })),
    [
      {
        level: "error",
        details: { graceMs: 0, connectionCount: 2 },
        message:
          "HTTP server did not close before shutdown grace period; forcing connections closed",
      },
      {
        level: "error",
        details: { err: forceCloseError },
        message: "Error force-closing HTTP connections",
      },
    ],
  );
});

test("HTTP shutdown force-closes when connection counting reports an error", async () => {
  const { entries, logger } = createLogger();
  let forcedConnections = 0;

  const result = await closeHttpServer(
    {
      close: () => undefined as never,
      closeAllConnections: () => {
        forcedConnections += 1;
      },
      getConnections: (callback) => {
        callback(new Error("connection count unavailable"), 0);
      },
    },
    0,
    logger,
  );

  assert.equal(result, "timed_out");
  assert.equal(forcedConnections, 1);
  assert.deepEqual(entries[1]?.details, {
    graceMs: 0,
    connectionCount: null,
  });
  assert.deepEqual(
    entries.map(({ level, message }) => [level, message]),
    [
      ["error", "Error counting active HTTP connections"],
      [
        "error",
        "HTTP server did not close before shutdown grace period; forcing connections closed",
      ],
    ],
  );
});

test("HTTP shutdown force-closes when connection counting throws synchronously", async () => {
  const { entries, logger } = createLogger();
  let forcedConnections = 0;

  const result = await closeHttpServer(
    {
      close: () => undefined as never,
      closeAllConnections: () => {
        forcedConnections += 1;
      },
      getConnections: () => {
        throw new Error("connection count unavailable");
      },
    },
    0,
    logger,
  );

  assert.equal(result, "timed_out");
  assert.equal(forcedConnections, 1);
  assert.deepEqual(entries[1]?.details, {
    graceMs: 0,
    connectionCount: null,
  });
  assert.deepEqual(
    entries.map(({ level, message }) => [level, message]),
    [
      ["error", "Error counting active HTTP connections"],
      [
        "error",
        "HTTP server did not close before shutdown grace period; forcing connections closed",
      ],
    ],
  );
});

test("HTTP shutdown counts and closes every active socket on a real server", async () => {
  const { entries, logger } = createLogger();
  const server = createServer();
  const sockets: ReturnType<typeof connect>[] = [];
  let connectedServerSockets = 0;
  let resolveConnections!: () => void;
  const connectionsEstablished = new Promise<void>((resolve) => {
    resolveConnections = resolve;
  });
  server.on("connection", () => {
    connectedServerSockets += 1;
    if (connectedServerSockets === 2) resolveConnections();
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => resolve());
    server.once("error", reject);
  });

  const address = server.address();
  assert(address && typeof address !== "string");

  try {
    sockets.push(
      connect({ host: "127.0.0.1", port: address.port }),
      connect({ host: "127.0.0.1", port: address.port }),
    );
    await Promise.all(sockets.map((socket) => once(socket, "connect")));
    await connectionsEstablished;

    // Observe closure before forcing it, without writing any request data.
    // Bound the wait so a missed socket fails rather than hanging native CI.
    const signal = AbortSignal.timeout(5_000);
    const clientClosures = sockets.map((socket) =>
      once(socket, "close", { signal }),
    );
    const serverClosure = once(server, "close", { signal });
    const [shutdownResult] = await Promise.all([
      closeHttpServer(
        {
          close: (callback) => server.close(callback),
          closeAllConnections: () => server.closeAllConnections(),
          getConnections: (callback) => server.getConnections(callback),
        },
        25,
        logger,
      ),
      ...clientClosures,
      serverClosure,
    ]);

    assert.equal(shutdownResult, "timed_out");
    for (const socket of sockets) {
      assert.equal(socket.destroyed, true);
    }
    const remainingConnections = await new Promise<number>((resolve, reject) =>
      server.getConnections((error, count) =>
        error ? reject(error) : resolve(count),
      ),
    );
    assert.equal(remainingConnections, 0);
    assert.deepEqual(entries, [
      {
        level: "error",
        details: { graceMs: 25, connectionCount: 2 },
        message:
          "HTTP server did not close before shutdown grace period; forcing connections closed",
      },
    ]);
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.close();
  }
});

test("HTTP shutdown ignores a late close callback after forcing connections", async () => {
  const { entries, logger } = createLogger();
  let closeCallback: ((error?: Error) => void) | undefined;
  let forcedConnections = 0;

  const result = await closeHttpServer(
    {
      close: (callback) => {
        closeCallback = callback;
        return undefined as never;
      },
      closeAllConnections: () => {
        forcedConnections += 1;
      },
      getConnections: (callback) => callback(null, 2),
    },
    0,
    logger,
  );

  closeCallback?.();

  assert.equal(result, "timed_out");
  assert.equal(forcedConnections, 1);
  assert.equal(entries.length, 1);
});