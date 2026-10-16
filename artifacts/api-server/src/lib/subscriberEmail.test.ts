import assert from "node:assert/strict";
import { mock, test } from "node:test";

import { ReplitConnectors } from "@replit/connectors-sdk";
import {
  sendAnalyticsCoverageRegressionEmail,
  sendSubmissionReceipt,
} from "./subscriberEmail";

test("submission receipt sends a personalized, escaped review notice and opt-in link", async () => {
  const calls: Array<{ connector: string; path: string; options: {
    method?: string;
    headers?: Record<string, string>;
    body?: { from: string; to: string[]; subject: string; html: string };
  } }> = [];
  const proxy = mock.method(
    ReplitConnectors.prototype,
    "proxy",
    async (connector: string, path: string, options?: typeof calls[number]["options"]) => {
      calls.push({ connector, path, options: options ?? {} });
      return new Response('{"id":"email-test"}', { status: 200 });
    },
  );
  try {
    await sendSubmissionReceipt(
      {
        id: 81,
        email: "owner@example.com",
        ownerName: 'Sam <script>alert("x")</script>',
        dogName: "Pup & Pal",
      },
      "https://topdogtricks.com",
    );
    assert.equal(calls.length, 1);
    const { connector, path, options } = calls[0]!;
    assert.equal(connector, "resend");
    assert.equal(path, "/emails");
    assert.equal(options.method, "POST");
    assert.equal(options.headers?.["Idempotency-Key"], "submission-receipt-81");
    assert.equal(options.body?.from, process.env.RESEND_FROM_EMAIL ?? "Top Dog Tricks <hello@topdogtricks.com>");
    assert.deepEqual(options.body?.to, ["owner@example.com"]);
    assert.equal(options.body?.subject, "We received your Top Dog Tricks entry");
    const html = options.body?.html ?? "";
    assert.match(html, /Sam &lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
    assert.match(html, /Pup &amp; Pal/);
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /awaiting review; it has not been accepted or published/);
    assert.match(html, /href="https:\/\/topdogtricks.com\/#newsletter"[^>]*>Subscribe to Top Dog Tricks<\/a>/);
    assert.match(html, /because you submitted a video/);
    assert.doesNotMatch(html, /because you asked for Top Dog Tricks updates/);
    assert.match(html, /does not subscribe you/);
  } finally {
    proxy.mock.restore();
  }
});

test("submission receipt surfaces a Resend failure to its caller", async () => {
  const proxy = mock.method(
    ReplitConnectors.prototype,
    "proxy",
    async () => new Response("Temporarily unavailable", { status: 503 }),
  );
  try {
    await assert.rejects(
      sendSubmissionReceipt(
        { id: 82, email: "owner@example.com", ownerName: "Sam", dogName: "Pup" },
        "https://topdogtricks.com",
      ),
      /Resend request failed \(503\)/,
    );
  } finally {
    proxy.mock.restore();
  }
});

test("coverage alert email uses aggregate cohort data and the shared idempotency key", async () => {
  const originalRecipient = process.env.ANALYTICS_COVERAGE_ALERT_EMAIL;
  process.env.ANALYTICS_COVERAGE_ALERT_EMAIL = "ops@example.com";
  const calls: Array<{ connector: string; path: string; options: {
    headers?: Record<string, string>;
    body?: { from: string; to: string[]; subject: string; html: string };
  } }> = [];
  const proxy = mock.method(
    ReplitConnectors.prototype,
    "proxy",
    async (connector: string, path: string, options?: typeof calls[number]["options"]) => {
      calls.push({ connector, path, options: options ?? {} });
      return new Response('{"id":"email-test"}', { status: 200 });
    },
  );
  try {
    await sendAnalyticsCoverageRegressionEmail(
      {
        cohorts: [
          { cohort: "2026-08-03", requests: 0 },
          { cohort: "2026-08-10", requests: 12 },
        ],
      },
      "319d8876-f23a-5c0b-b327-774047cbb5c9",
    );
    assert.equal(calls.length, 1);
    const { connector, path, options } = calls[0]!;
    assert.equal(connector, "resend");
    assert.equal(path, "/emails");
    assert.equal(
      options.headers?.["Idempotency-Key"],
      "319d8876-f23a-5c0b-b327-774047cbb5c9",
    );
    assert.deepEqual(options.body?.to, ["ops@example.com"]);
    assert.equal(options.body?.subject, "Analytics coverage regression detected");
    assert.match(options.body?.html ?? "", /2026-08-03<\/strong>: 0 native requests/);
    assert.match(options.body?.html ?? "", /2026-08-10<\/strong>: 12 native requests/);
    assert.match(options.body?.html ?? "", /Automated operator alert/);
    assert.doesNotMatch(
      options.body?.html ?? "",
      /\b(session_id|subscriber_id|email|token|url_query|subscriber_email)\b/i,
    );
  } finally {
    proxy.mock.restore();
    if (originalRecipient === undefined) {
      delete process.env.ANALYTICS_COVERAGE_ALERT_EMAIL;
    } else {
      process.env.ANALYTICS_COVERAGE_ALERT_EMAIL = originalRecipient;
    }
  }
});

test("coverage alert email fails explicitly when no operator recipient is configured", async () => {
  const originalRecipient = process.env.ANALYTICS_COVERAGE_ALERT_EMAIL;
  delete process.env.ANALYTICS_COVERAGE_ALERT_EMAIL;
  try {
    await assert.rejects(
      sendAnalyticsCoverageRegressionEmail(
        { cohorts: [{ cohort: "2026-08-03", requests: 0 }] },
        "319d8876-f23a-5c0b-b327-774047cbb5c9",
      ),
      /ANALYTICS_COVERAGE_ALERT_EMAIL is required/,
    );
  } finally {
    if (originalRecipient !== undefined) {
      process.env.ANALYTICS_COVERAGE_ALERT_EMAIL = originalRecipient;
    }
  }
});