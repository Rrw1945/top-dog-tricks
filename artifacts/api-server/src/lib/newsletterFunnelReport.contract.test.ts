import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { getNewsletterFunnelReport } from "./newsletterFunnelAnalytics";

type NativeReport = Awaited<ReturnType<typeof getNewsletterFunnelReport>>["native"];

// Load the real guard without adding frontend source to the API tsconfig root.
// Runtime esbuild loading also avoids bundling esbuild inside the test bundle.
const esbuildModule = "esbuild";
const { transform } = await import(esbuildModule) as typeof import("esbuild");
const guardSource = await readFile(resolve(
  process.cwd(), "../top-dog-tricks/src/lib/newsletter-funnel-report.ts",
), "utf8");
const { code } = await transform(guardSource, { loader: "ts", format: "esm" });
const guardUrl = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
const { getNativeFunnelReportView } = await import(guardUrl) as {
  getNativeFunnelReportView(native: unknown): {
    rows: NativeReport["rows"];
    comparison: NativeReport["comparison"] | null;
    unavailableReason: "sources" | "comparison" | null;
  };
};

type Counts = readonly [requests: number, confirmations: number];

async function nativeReport(initial: Counts, replacement: Counts) {
  const report = await getNewsletterFunnelReport(
    new Date("2026-09-10T12:00:00Z"),
    async (query) => query.includes("coverage_start_cohort") ? [] :
      (["cohort_aligned", "historical_aggregate_only"] as const).flatMap(
        (report_section) => (["initial", "replacement"] as const).map(
          (source, index) => ({
            report_section,
            source,
            requests: [initial, replacement][index][0],
            confirmations: [initial, replacement][index][1],
          }),
        ),
      ),
  );
  // Exercise the HTTP JSON boundary, not a separately maintained UI fixture.
  return JSON.parse(JSON.stringify(report.native)) as typeof report.native;
}

const cases: {
  name: string;
  initial: Counts;
  replacement: Counts;
  rates: [number | null, number | null];
  lift: number | null;
  result: string;
}[] = [
  { name: "no requests", initial: [0, 0], replacement: [0, 0],
    rates: [null, null], lift: null, result: "Inconclusive · sample too small" },
  { name: "only initial has requests", initial: [30, 30], replacement: [0, 0],
    rates: [100, null], lift: null, result: "Inconclusive · sample too small" },
  { name: "only replacement has requests", initial: [0, 0], replacement: [30, 0],
    rates: [null, 0], lift: null, result: "Inconclusive · sample too small" },
  { name: "zero conversion in both sources", initial: [100, 0], replacement: [30, 0],
    rates: [0, 0], lift: 0, result: "Inconclusive · difference includes zero" },
  { name: "full conversion in both sources", initial: [30, 30], replacement: [100, 100],
    rates: [100, 100], lift: 0, result: "Inconclusive · difference includes zero" },
  { name: "maximum positive lift", initial: [100, 0], replacement: [30, 30],
    rates: [0, 100], lift: 100, result: "Replacement outperforms" },
  { name: "maximum negative lift", initial: [30, 30], replacement: [100, 0],
    rates: [100, 0], lift: -100, result: "Replacement underperforms" },
  { name: "single-request positive lift", initial: [1, 0], replacement: [1, 1],
    rates: [0, 100], lift: 100, result: "Inconclusive · sample too small" },
  { name: "single-request negative lift", initial: [1, 1], replacement: [1, 0],
    rates: [100, 0], lift: -100, result: "Inconclusive · sample too small" },
  { name: "tiny repeating-decimal rates", initial: [3, 1], replacement: [3, 2],
    rates: [100 / 3, 200 / 3], lift: 100 / 3, result: "Inconclusive · sample too small" },
  { name: "repeating-decimal negative lift", initial: [300, 200], replacement: [300, 100],
    rates: [200 / 3, 100 / 3], lift: -100 / 3, result: "Replacement underperforms" },
  { name: "negative lift whose interval includes zero", initial: [30, 16], replacement: [30, 15],
    rates: [160 / 3, 50], lift: -10 / 3, result: "Inconclusive · difference includes zero" },
  { name: "one source below the sample threshold", initial: [29, 0], replacement: [30, 30],
    rates: [0, 100], lift: 100, result: "Inconclusive · sample too small" },
];

function assertMetric(actual: number | null, expected: number | null) {
  if (expected === null) {
    assert.equal(actual, null);
  } else {
    assert.notEqual(actual, null);
    assert.ok(Math.abs(actual! - expected) < 1e-12, `${actual} != ${expected}`);
  }
}

for (const scenario of cases) {
  test(`API-to-report guard accepts ${scenario.name}`, async () => {
    const native = await nativeReport(scenario.initial, scenario.replacement);
    const view = getNativeFunnelReportView(native);
    assert.equal(view.unavailableReason, null);
    // No valid row, interval, or comparison may be discarded or rewritten.
    assert.deepEqual(view.rows, native.rows);
    assert.deepEqual(view.comparison, native.comparison);
    assert.equal(view.rows.length, 2);
    view.rows.forEach((row, index) =>
      assertMetric(row.conversionRatePercent, scenario.rates[index]));
    assert.ok(view.comparison);
    assertMetric(view.comparison.liftPoints, scenario.lift);
    assert.equal(view.comparison.result, scenario.result);
  });
}

test("real Wilson endpoint roundoff remains visible without modifying API metrics", async () => {
  const native = await nativeReport([100, 0], [30, 30]);
  const [zero, full] = native.rows;
  // These inputs deliberately produce non-exact endpoints in the real calculator.
  // Strict interval containment would reject both otherwise valid rows.
  assert.equal(zero.conversionRatePercent, 0);
  assert.ok(zero.ci95LowerPercent! > 0);
  assert.ok(zero.ci95LowerPercent! < 1e-12);
  assert.equal(full.conversionRatePercent, 100);
  assert.ok(full.ci95UpperPercent! < 100);
  assert.ok(100 - full.ci95UpperPercent! < 1e-12);
  assert.ok(native.comparison.liftCi95UpperPoints! > 100);
  assert.ok(native.comparison.liftCi95UpperPoints! - 100 < 1e-12);
  const view = getNativeFunnelReportView(native);
  assert.equal(view.unavailableReason, null);
  assert.deepEqual(view.rows, native.rows);
  assert.deepEqual(view.comparison, native.comparison);
});

test("endpoint tolerance does not admit materially out-of-range intervals", async () => {
  const native = await nativeReport([100, 0], [30, 30]);
  for (const [field, value] of [
    ["liftCi95LowerPoints", -100.000001],
    ["liftCi95UpperPoints", 100.000001],
  ] as const) {
    assert.equal(getNativeFunnelReportView({
      ...native,
      comparison: { ...native.comparison, [field]: value },
    }).unavailableReason, "comparison");
  }
  for (const [index, field, value] of [
    [0, "ci95LowerPercent", -0.000001],
    [1, "ci95UpperPercent", 100.000001],
  ] as const) {
    assert.equal(getNativeFunnelReportView({
      ...native,
      rows: native.rows.map((row, rowIndex) =>
        rowIndex === index ? { ...row, [field]: value } : row),
    }).unavailableReason, "sources");
  }
});
