import type { RequestHandler } from "express";

// America/Phoenix is UTC−07:00 year-round. The entire advertised final
// minute qualifies; there is deliberately no opening-date restriction.
export const FIRST_CONTEST_CLOSES_AT = "2027-01-01T07:00:00.000Z";
export const FIRST_CONTEST_CLOSED_MESSAGE =
  "Entries for our first contest are closed. The deadline was December 31, 2026 at 11:59 p.m. Arizona time (MST). Existing entries, including early submissions, remain in the contest.";

export const requireFirstContestOpen: RequestHandler = (_req, res, next) => {
  if (Date.now() >= Date.parse(FIRST_CONTEST_CLOSES_AT)) {
    res.status(403).json({
      code: "CONTEST_CLOSED",
      error: FIRST_CONTEST_CLOSED_MESSAGE,
    });
    return;
  }
  next();
};
