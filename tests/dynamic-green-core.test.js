const test = require("node:test");
const assert = require("node:assert/strict");
const engine = require("../dynamic-green-core.js");

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);
const job = (id, arrival, departure, reportedSize, other = {}) => ({ id, arrival, departure, reportedSize, reportedDuration: departure - arrival, ...other });
const run = (jobs, algorithm, capacity = 1, green = 0.5, price = 5, width = 2) =>
  engine.simulate(jobs, algorithm, capacity, green, price, width, true);

test("weighted Hard probability stays between the two inputs", () => {
  close(engine.combinedProbability(0.5, 0.5, 0.5), 0.5);
  close(engine.combinedProbability(0.2, 0.5, 0.5), 0.35);
  close(engine.combinedProbability(0.2, 0.5, 0), 0.2);
  close(engine.combinedProbability(0.2, 0.5, 1), 0.5);
  close(engine.durationProbability(7, 7, 1.5), 0.5);
});

test("sampling applies duration error and one shared mode before reporting", () => {
  const values = [0.8, 0.5, 0.75, 0.2];
  let index = 0;
  const settings = { jobs: 1, arrivalPattern: "fixed", arrivalInterval: 1,
    durationMin: 10, durationMax: 10, errorType: "none", errorScale: 0,
    durationError: 0.2, durationMidpoint: 10, durationWidth: 2, timeWeight: 0.5,
    simpleSize: 0.2, hardSize: 0.7, simpleDuration: 4, hardDuration: 8 };
  const sampled = engine.sampleTrial(settings, () => 0.5, () => values[index++]);
  const item = sampled[0];
  close(item.actualSize, 0.8);
  close(item.actualDuration, 10);
  close(item.estimatedDuration, 11);
  close(item.hardProbability, (0.5 + engine.durationProbability(11, 10, 2)) / 2);
  assert.equal(item.hard, true);
  close(item.reportedSize, 0.8);
  close(item.reportedDuration, 11);
  close(item.departure, 11);
});

test("departures free reported capacity before same-time arrivals and cost integrates over time", () => {
  const jobs = [job(1, 0, 1, 0.4), job(2, 0, 3, 0.4), job(3, 1, 2, 0.4, { actualSize: 0.99 })];
  const outcome = run(jobs, "first-fit");
  assert.deepEqual(outcome.assignments.map((item) => item.binId), [1, 1, 1]);
  assert.equal(outcome.peakBins, 1);
  assert.equal(outcome.opened, 1);
  close(outcome.binTime, 3);
  close(outcome.blackTime, 0.6);
  close(outcome.total, 6);
  assert.equal(outcome.events.at(-1).activeBins, 0);
});

test("non-clairvoyant fit rules and clairvoyant closing-time rules choose different bins", () => {
  const fitJobs = [job(1, 0, 10, 0.4), job(2, 0, 10, 0.7), job(3, 0, 10, 0.2)];
  assert.deepEqual(run(fitJobs, "first-fit").assignments.map((item) => item.binId), [1, 2, 1]);
  assert.deepEqual(run(fitJobs, "best-fit").assignments.map((item) => item.binId), [1, 2, 2]);
  assert.deepEqual(run(fitJobs, "mru").assignments.map((item) => item.binId), [1, 2, 2]);
  const timeJobs = [job(1, 0, 10, 0.6), job(2, 0, 5, 0.6), job(3, 0, 6, 0.2)];
  assert.deepEqual(run(timeJobs, "greedy").assignments.map((item) => item.binId), [1, 2, 1]);
  assert.deepEqual(run(timeJobs, "nrt").assignments.map((item) => item.binId), [1, 2, 2]);
  assert.deepEqual(run(timeJobs, "prioritized-nrt").assignments.map((item) => item.binId), [1, 2, 1]);
});

test("Round Robin Next Fit searches open bins while Next Fit abandons the old bin", () => {
  const jobs = [job(1, 0, 10, 0.4), job(2, 0, 10, 0.7), job(3, 0, 10, 0.4)];
  assert.deepEqual(run(jobs, "next-fit").assignments.map((item) => item.binId), [1, 2, 3]);
  assert.deepEqual(run(jobs, "round-robin-next-fit").assignments.map((item) => item.binId), [1, 2, 1]);
});

test("non-clairvoyant placement cannot change when only future departures change", () => {
  const early = [job(1, 0, 4, 0.6), job(2, 0, 8, 0.6), job(3, 0, 5, 0.2)];
  const late = [job(1, 0, 20, 0.6), job(2, 0, 8, 0.6), job(3, 0, 5, 0.2)];
  for (const algorithm of engine.NON_CLAIRVOYANT) {
    assert.deepEqual(run(early, algorithm).assignments, run(late, algorithm).assignments, algorithm);
  }
  assert.notDeepEqual(run(early, "greedy").assignments, run(late, "greedy").assignments);
});

test("departure and duration classes keep different categories apart", () => {
  const jobs = [job(1, 0, 2, 0.2), job(2, 0, 5, 0.2)];
  assert.deepEqual(run(jobs, "departure-class", 1, 0.5, 5, 2).assignments.map((item) => item.binId), [1, 2]);
  assert.deepEqual(run(jobs, "duration-class").assignments.map((item) => item.binId), [1, 2]);
  assert.deepEqual(run(jobs, "first-fit").assignments.map((item) => item.binId), [1, 1]);
});

test("threshold singleton and full-capacity reference use different capacities", () => {
  const jobs = [job(1, 0, 2, 0.7), job(2, 0, 2, 0.2)];
  assert.deepEqual(run(jobs, "first-fit", 0.6).assignments.map((item) => item.binId), [1, 2]);
  assert.deepEqual(run(jobs, "full-first-fit", 0.6).assignments.map((item) => item.binId), [1, 1]);
});

test("seed reproduces jobs and results", () => {
  const settings = { jobs: 30, arrivalPattern: "exponential", arrivalInterval: 0.4,
    durationMin: 2, durationMax: 12, errorType: "normal", errorScale: 0.08,
    durationError: 0.2, durationMidpoint: 7, durationWidth: 1.5, timeWeight: 0.5,
    simpleSize: 0.2, hardSize: 0.7, simpleDuration: 4, hardDuration: 8 };
  const a = engine.sampleTrial(settings, (z) => z, engine.seededRandom(42));
  const b = engine.sampleTrial(settings, (z) => z, engine.seededRandom(42));
  assert.deepEqual(a, b);
  for (const algorithm of engine.ALGORITHMS) {
    const outcome = run(a, algorithm, 0.6);
    assert.ok(Number.isFinite(outcome.total), algorithm);
    assert.equal(outcome.events.at(-1).activeBins, 0, algorithm);
    close(outcome.total, outcome.binTime + 5 * outcome.blackTime);
  }
});
