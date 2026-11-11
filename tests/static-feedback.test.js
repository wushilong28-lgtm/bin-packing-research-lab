const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "app.js"), "utf8");
const simulationSource = source.slice(source.indexOf("  const errorTypes ="), source.indexOf("  function drawProbabilityCurve()"));
const base = { lambda: 0, jobs: 500, trials: 1, algorithm: "first-fit", probabilityExpression: "0.5", simpleThreshold: 0.4, hardThreshold: 0.7, errorType: "none", errorScale: 0, feedbackEnabled: true, feedbackCoefficient: 2 };

function load(random) {
  const math = Object.create(Math);
  math.random = random;
  const context = { window: {}, Math: math, requestAnimationFrame: (callback) => callback() };
  for (const file of ["probability.js", "static-behavior.js"]) vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), context);
  return vm.runInNewContext(simulationSource + "\n({ runSimulation, validate });", context);
}
function seeded() {
  let state = 0x20261027;
  return () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
}
function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
}
async function run(settings, random = seeded()) {
  return load(random).runSimulation({ ...base, ...settings }, () => {}, 0);
}

test("feedback uses perceived size before reporting, with positive/negative error and clipping", async () => {
  const draws = [
    0.2, 0.9, 0.75, // True below s, perceived 0.6, Simple: alpha = 0.4.
    0.8, 0.0, 0.75, // True above s, perceived 0.3, Simple: alpha = 0.
    0.8, 0.8, 0.25, // Perceived clips to 1, Hard: alpha = 0.
    0.1, 0.0, 0.75, // Perceived clips to 0, Simple: alpha = 0.
    0.8, 0.99, 0.75, // Perceived clips to 1, Simple: alpha = 1.2.
    0.4, 0.5, 0.75, // Perceived equals s: alpha = 0.
  ];
  let at = 0;
  const result = await run({ jobs: 6, errorType: "uniform", errorScale: 0.5 }, () => {
    assert.ok(at < draws.length, "Unexpected random draw");
    return draws[at++];
  });
  const expected = [0.4, 0, 0, 0, 1.2, 0];
  result.firstRows.forEach((row, i) => near(row.feedback, expected[i]));
  assert.equal(at, draws.length);
  assert.deepEqual(Array.from(result.firstRows, (row) => row.simpleIndicator), [1, 1, 0, 1, 1, 1]);
  assert.deepEqual(Array.from(result.trueCounts), [4]);
  assert.deepEqual(Array.from(result.reportedCounts), [3]);
  near(result.feedbackMean, 1.6);
  near(result.objectiveMean, 4.6);
  near(result.objectiveDifferenceMean, 0.6);
  near(result.feedbackJobMean, 2);
});

test("objectives include every job and every trial, not only the 100 preview rows", async () => {
  const result = await run({ jobs: 1000, trials: 2, probabilityExpression: "0" }, () => 0.8);
  assert.equal(result.firstRows.length, 100);
  near(result.feedbackMean, 800);
  near(result.feedbackJobMean, 1000);
  near(result.reportedMean, 500);
  near(result.trueMean, 1000);
  near(result.objectiveMean, 1300);
  near(result.objectiveDifferenceMean, 300);
  result.feedbackTotals.forEach((total) => near(total, 800));
});

test("lambda-zero baseline: feedback off, zero c and coefficient changes preserve sampling and placements", async () => {
  for (const algorithm of ["first-fit", "best-fit", "next-fit", "random-fit"]) {
    const settings = { algorithm, jobs: 500, trials: 2, errorType: "uniform", errorScale: 0.3 };
    const on = await run(settings);
    const off = await run({ ...settings, feedbackEnabled: false });
    const zero = await run({ ...settings, feedbackCoefficient: 0 });
    const scaled = await run({ ...settings, feedbackCoefficient: 5 });
    for (const result of [off, zero, scaled]) {
      assert.deepEqual(Array.from(result.trueCounts), Array.from(on.trueCounts));
      assert.deepEqual(Array.from(result.reportedCounts), Array.from(on.reportedCounts));
      assert.deepEqual(Array.from(result.firstRows, (row) => [row.actual, row.perceived, row.hard, row.trueBin, row.reportedBin]), Array.from(on.firstRows, (row) => [row.actual, row.perceived, row.hard, row.trueBin, row.reportedBin]));
    }
    near(off.feedbackMean, 0);
    near(zero.feedbackMean, 0);
    near(off.objectiveMean, off.reportedMean);
    near(zero.objectiveMean, zero.reportedMean);
    near(scaled.feedbackMean, on.feedbackMean * 2.5);
    on.reportedObjectives.forEach((score, i) => near(score, on.reportedCounts[i] + on.feedbackTotals[i]));
  }
});

test("Hard jobs and a Simple cap of one give zero feedback", async () => {
  for (const settings of [{ probabilityExpression: "1" }, { probabilityExpression: "0", simpleThreshold: 1 }]) {
    const result = await run(settings);
    near(result.feedbackMean, 0);
    near(result.objectiveMean, result.reportedMean);
  }
});

test("feedback defaults are backwards compatible and enabled coefficients are validated", () => {
  const { validate } = load(seeded());
  const legacy = { ...base };
  delete legacy.feedbackEnabled;
  delete legacy.feedbackCoefficient;
  assert.equal(validate(legacy).feedbackEnabled, false);
  assert.equal(validate(legacy).feedbackCoefficient, 1);
  for (const c of [-1, NaN, Infinity, 1e308]) assert.throws(() => validate({ ...base, feedbackCoefficient: c }), /Feedback coefficient/);
  assert.throws(() => validate({ ...base, feedbackEnabled: "false" }), /on or off/);
  assert.equal(validate({ ...base, feedbackCoefficient: 0 }).feedbackCoefficient, 0);
  assert.equal(validate({ ...base, feedbackCoefficient: 5 }).feedbackCoefficient, 5);
  assert.equal(validate({ ...base, feedbackCoefficient: 0.125 }).feedbackCoefficient, 0.125);
  assert.equal(validate({ ...base, feedbackEnabled: false, feedbackCoefficient: NaN }).feedbackEnabled, false);
});
