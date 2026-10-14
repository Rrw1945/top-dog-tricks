import assert from "node:assert/strict";
import { test } from "node:test";
import type { Request, Response } from "express";
import { FIRST_CONTEST_CLOSES_AT, requireFirstContestOpen } from "./firstContest";

test("first contest allows early entries and the entire last minute, but not midnight or later", (t) => {
  assert.equal(FIRST_CONTEST_CLOSES_AT, "2027-01-01T07:00:00.000Z");
  for (const [time, open] of [
    ["2026-09-01T00:00:00Z", true],
    ["2027-01-01T06:59:00Z", true],
    ["2027-01-01T06:59:59.999Z", true],
    ["2027-01-01T07:00:00Z", false],
    ["2027-01-01T07:00:00.001Z", false],
    ["2028-01-01T00:00:00Z", false],
  ] as const) {
    t.mock.method(Date, "now", () => Date.parse(time));
    let nextCalled = false;
    let status: number | undefined;
    let body: unknown;
    const res = {
      status(code: number) { status = code; return this; },
      json(value: unknown) { body = value; },
    } as Response;
    requireFirstContestOpen({} as Request, res, () => { nextCalled = true; });
    assert.equal(nextCalled, open, time);
    if (!open) {
      assert.equal(status, 403);
      assert.equal((body as { code: string }).code, "CONTEST_CLOSED");
    } else {
      assert.equal(status, undefined);
    }
    t.mock.restoreAll();
  }
});
