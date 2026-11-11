const test = require("node:test");
const assert = require("node:assert/strict");
const engine = require("../green-core.js");

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

test("reporting follows true size → perception → mode → final report", () => {
  const values = [0.8, 0.1, 0.3, 0.9];
  let index = 0;
  const settings = { jobs: 2, errorType: "none", errorScale: 0, simpleThreshold: 0.2, hardThreshold: 0.7 };
  const sample = engine.sampleTrial(settings, (z) => z, () => values[index++]);
  assert.deepEqual([...sample.actual], [0.8, 0.3]);
  assert.deepEqual([...sample.perceived], [0.8, 0.3]);
  assert.deepEqual([...sample.hardModes], [1, 0]);
  assert.deepEqual([...sample.reported], [0.8, 0.2]);
});

test("g(z) = 0 always selects Simple and g(z) = 1 always selects Hard", () => {
  const settings = { jobs: 1, errorType: "none", errorScale: 0, simpleThreshold: 0.2, hardThreshold: 0.7 };
  const simple = engine.sampleTrial(settings, () => 0, engine.seededRandom(17));
  const hard = engine.sampleTrial(settings, () => 1, engine.seededRandom(17));
  assert.deepEqual([...simple.hardModes], [0]);
  assert.deepEqual([...hard.hardModes], [1]);
  close(simple.reported[0], Math.min(0.2, simple.actual[0]));
  close(hard.reported[0], Math.max(0.7, hard.actual[0]));
});

test("packing and cost ignore true-size overflow", () => {
  const values = [0.8, 0.1, 0.8, 0.1];
  let index = 0;
  const settings = { jobs: 2, errorType: "none", errorScale: 0, simpleThreshold: 0.2, hardThreshold: 0.7 };
  const sample = engine.sampleTrial(settings, () => 0, () => values[index++]);
  const loads = engine.pack(sample.reported, "first-fit", 0.5);
  assert.equal(sample.actual[0] + sample.actual[1] > 1, true);
  assert.equal(loads.length, 1);
  close(loads[0], 0.4);
  assert.deepEqual(engine.cost(loads, 0.5, 5), { bins: 1, openingCost: 1, blackVolume: 0, blackCost: 0, total: 1 });
});

test("cost charges the reported fill above G, including singleton jobs", () => {
  for (const name of engine.ALGORITHMS) assert.deepEqual(engine.pack([0.8, 0.2], name, 0.7), [0.8, 0.2], name);
  const loads = engine.pack([0.8, 0.2], "first-fit", 0.7);
  const result = engine.cost(loads, 0.5, 5);
  assert.equal(result.bins, 2);
  close(result.blackVolume, 0.3);
  close(result.blackCost, 1.5);
  close(result.total, 3.5);
});

test("threshold boundaries and algorithm choices are honored", () => {
  for (const name of engine.ALGORITHMS.filter((algorithm) => algorithm !== "harmonic")) {
    const loads = engine.pack([0.4, 0.3], name, 0.7);
    assert.equal(loads.length, 1, `${name} should allow filling exactly to G + τ`);
    close(loads[0], 0.7);
  }
  assert.deepEqual(engine.pack([0.35, 0.35], "harmonic", 0.7), [0.7]);
  assert.deepEqual(engine.pack([0.4, 0.5, 0.1], "best-fit", 0.7), [0.4, 0.6]);
  assert.deepEqual(engine.pack([0.4, 0.5, 0.1], "worst-fit", 0.7), [0.5, 0.5]);
  assert.deepEqual(engine.pack([0.6, 0.6, 0.4, 0.4], "next-fit", 1), [0.6, 1, 0.4]);
  assert.deepEqual(engine.pack([0.6, 0.6, 0.4, 0.4], "first-fit", 1), [1, 1]);
});

test("assignment capture records the original placement without changing packing", () => {
  const sizes = [0.4, 0.5, 0.1, 0.8];
  for (const algorithm of engine.ALGORITHMS) {
    const assignments = [];
    const loads = engine.pack(sizes, algorithm, 0.7, 10, assignments);
    assert.deepEqual(loads, engine.pack(sizes, algorithm, 0.7), algorithm);
    assert.equal(assignments.length, sizes.length, algorithm);
    assert.ok(assignments.every((bin) => Number.isInteger(bin) && bin >= 1 && bin <= loads.length), algorithm);
  }
  const first = [];
  engine.pack(sizes, "first-fit", 0.7, 10, first);
  assert.deepEqual(first, [1, 2, 1, 3]);
});

test("Harmonic separates size classes and uses one active bin per class", () => {
  assert.equal(engine.harmonicClass(0.6, 1, 10), 0);
  assert.equal(engine.harmonicClass(0.5, 1, 10), 1);
  assert.equal(engine.harmonicClass(0.1, 1, 10), 9);
  assert.deepEqual(engine.pack([0.4, 0.2, 0.35], "harmonic", 1, 10), [0.75, 0.2]);
});

test("G = 1 collapses green cost to the classical bin count", () => {
  const sizes = [0.6, 0.6, 0.4, 0.4];
  for (const name of engine.ALGORITHMS) {
    const loads = engine.pack(sizes, name, 1);
    const result = engine.cost(loads, 1, 25);
    assert.equal(result.total, result.bins);
    assert.equal(result.blackVolume, 0);
    for (const load of loads) assert.ok(load <= 1 + 1e-12);
  }
});

test("the full threshold agrees with full-capacity First Fit", () => {
  const reported = [0.2, 0.7, 0.15, 0.9, 0, 0.35];
  const greenCapacity = 0.45;
  const threshold = 1 - greenCapacity;
  const thresholdLoads = engine.pack(reported, "first-fit", greenCapacity + threshold);
  const referenceLoads = engine.pack(reported, "first-fit", 1);
  assert.deepEqual(thresholdLoads, referenceLoads);
  assert.deepEqual(engine.cost(thresholdLoads, greenCapacity, 1.5), engine.cost(referenceLoads, greenCapacity, 1.5));
});

test("seeded sampling is reproducible", () => {
  const settings = { jobs: 100, errorType: "normal", errorScale: 0.08, simpleThreshold: 0.2, hardThreshold: 0.7 };
  const first = engine.sampleTrial(settings, (z) => z, engine.seededRandom(42));
  const second = engine.sampleTrial(settings, (z) => z, engine.seededRandom(42));
  assert.deepEqual([...first.reported], [...second.reported]);
  assert.deepEqual([...first.hardModes], [...second.hardModes]);
});

test("optimized fit choices match an independent linear-scan reference", () => {
  function reference(sizes, algorithm, capacity) {
    const loads = [];
    for (const size of sizes) {
      if (size > capacity + 1e-12) { loads.push(size); continue; }
      let selected = -1;
      for (let i = 0; i < loads.length; i += 1) {
        if (loads[i] > capacity + 1e-12 || loads[i] + size > capacity + 1e-12) continue;
        if (selected < 0 ||
            (algorithm === "best-fit" && loads[i] > loads[selected]) ||
            (algorithm === "worst-fit" && loads[i] < loads[selected])) selected = i;
        if (algorithm === "first-fit") break;
      }
      if (selected < 0) loads.push(size);
      else loads[selected] += size;
    }
    return loads;
  }
  const random = engine.seededRandom(31021);
  for (let trial = 0; trial < 60; trial += 1) {
    const capacity = 0.35 + random() * 0.65;
    const sizes = Array.from({ length: 60 }, () => Math.floor(random() * 21) / 20);
    for (const algorithm of ["first-fit", "best-fit", "worst-fit"]) {
      const actual = engine.pack(sizes, algorithm, capacity);
      const expected = reference(sizes, algorithm, capacity);
      assert.equal(actual.length, expected.length, `${algorithm}, trial ${trial}`);
      actual.forEach((load, i) => assert.ok(Math.abs(load - expected[i]) < 1e-9, `${algorithm}, trial ${trial}, bin ${i}: ${load} ≠ ${expected[i]}`));
    }
  }
});
