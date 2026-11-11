const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const behavior = require("../static-behavior.js");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "app.js"), "utf8");
const simulationSource = source.slice(source.indexOf("  const errorTypes ="), source.indexOf("  function drawProbabilityCurve()"));
function load() {
  const context = { window: { StaticBehavior: behavior }, Math, requestAnimationFrame: cb => cb() };
  vm.runInNewContext(fs.readFileSync(path.join(root, "probability.js"), "utf8"), context);
  return vm.runInNewContext(simulationSource + "\n({ packers, validate, runSimulation });", context);
}
const base = { jobs: 500, trials: 2, algorithm: "two-layer-ff", reservationLimit: 10,
  probabilityExpression: "0.5", simpleThreshold: .4, hardThreshold: .6,
  errorType: "normal", errorScale: .08, feedbackEnabled: true, feedbackCoefficient: 1,
  lambda: .5, seed: "20261029" };
function pack(algorithm, values, limit = 10, s = .4) {
  const { packers } = load(), bins = [], stats = {};
  const jobs = values.map(size => ({ size, hard: size >= .5, row: {} }));
  const count = packers[algorithm](jobs, bins, undefined, jobs.length,
    { simpleThreshold: s, hardThreshold: 1-s, reservationLimit: limit }, stats);
  return { count, bins, stats, jobs };
}

// Independent linear-scan oracle for the priority rule and global bin IDs.
function reference(jobs, algorithm, limit, s) {
  const bins = [], assignments = [], pending = [];
  const choose = candidates => algorithm === "two-layer-bf"
    ? candidates.reduce((best, bin) => !best || bin.remaining < best.remaining ? bin : best, null)
    : candidates[0];
  for (const job of jobs) {
    const simpleAtom = !job.hard && job.size === s, hardAtom = job.hard && job.size === 1-s;
    let bin;
    if (simpleAtom && limit>0) bin=choose(bins.filter(b=>b.pool==="ordinary" && b.hard && b.remaining+1e-12>=job.size));
    if (!bin && hardAtom && pending.length) { bin=pending.shift(); bin.pool="paired"; }
    if (!bin && simpleAtom && pending.length<limit) {
      bin={id:bins.length+1,remaining:1,hard:false,pool:"reserved"}; bins.push(bin); pending.push(bin);
    }
    if (!bin) bin=choose(bins.filter(b=>b.pool==="ordinary" && b.remaining+1e-12>=job.size));
    if (!bin) { bin={id:bins.length+1,remaining:1,hard:false,pool:"ordinary"}; bins.push(bin); }
    bin.remaining=Math.max(0,bin.remaining-job.size); bin.hard ||= job.hard;
    assignments.push(bin.id);
  }
  return {count:bins.length,assignments};
}

test("reserved threshold Simple jobs pair with later threshold Hard jobs", () => {
  for (const algorithm of ["two-layer-ff", "two-layer-bf"]) {
    const result = pack(algorithm, [.4,.4,.6,.6], 2);
    assert.equal(result.count, 2);
    assert.deepEqual(result.bins, [1,2,1,2]);
    assert.equal(result.stats.pairs, 2);
    assert.equal(result.stats.unmatched, 0);
    assert.equal(result.stats.ordinaryBins, 0);
  }
});

test("Hard is never reserved and its ordinary bin accepts nonthreshold Simple", () => {
  for (const algorithm of ["two-layer-ff", "two-layer-bf"]) {
    const result = pack(algorithm, [.8,.1,.1], 10, .2);
    assert.deepEqual(result.bins,[1,1,1]);
    assert.equal(result.count,1);
    assert.equal(result.stats.pairs,0);
    assert.equal(result.stats.unmatched,0);
    assert.equal(result.stats.peakReserved,0);
    assert.equal(result.stats.overflow,0);
    assert.ok(result.jobs.every(job=>job.row.placementLayer==="Ordinary pool"));
    const hardFirst = pack(algorithm,[.6,.6,.4,.4],2);
    assert.deepEqual(hardFirst.bins,[1,2,1,2]);
    assert.equal(hardFirst.stats.pairs,0); // Existing Hard bins stay in the ordinary layer.
    assert.equal(hardFirst.stats.ordinaryHardFills,2);
    assert.equal(hardFirst.stats.unmatched,0);
    assert.equal(hardFirst.stats.ordinaryBins,2);
    assert.ok(hardFirst.jobs.slice(0,2).every(job=>job.row.placementLayer==="Ordinary pool"));
  }
});

test("threshold Simple fills an existing Hard bin before opening a reservation", () => {
  for (const algorithm of ["two-layer-ff", "two-layer-bf"]) {
    const minimal=pack(algorithm,[.8,.2],10,.2);
    assert.deepEqual(minimal.bins,[1,1]);
    assert.equal(minimal.count,1);
    assert.equal(minimal.stats.ordinaryHardFills,1);
    assert.equal(minimal.stats.unmatched,0);
    assert.match(minimal.jobs[1].row.placementLayer,/filled before reservation/);
    const priority=pack(algorithm,[.3,.3,.6,.4],1);
    assert.deepEqual(priority.bins,[1,1,2,2]); // Prefer the Hard bin over an older Simple-only bin.
    assert.equal(priority.stats.ordinaryHardFills,1);
    const zero=pack(algorithm,[.3,.3,.6,.4],0);
    assert.deepEqual(zero.bins,[1,1,2,1]); // K=0 retains ordinary FF/BF behavior.
    assert.equal(zero.stats.ordinaryHardFills,0);
  }
});

test("existing-Hard checks use current residual capacity and update the ordinary packer", () => {
  for (const algorithm of ["two-layer-ff", "two-layer-bf"]) {
    const stale=pack(algorithm,[.8,.8,.1,.2],10,.2);
    assert.deepEqual(stale.bins,[1,2,1,2]);
    assert.equal(stale.stats.ordinaryHardFills,1);
    const updated=pack(algorithm,[.8,.8,.2,.19],10,.2);
    assert.deepEqual(updated.bins,[1,2,1,2]);
    const blocked=pack(algorithm,[.8,.1,.2],10,.2);
    assert.deepEqual(blocked.bins,[1,1,2]);
    assert.equal(blocked.stats.ordinaryHardFills,0);
    assert.equal(blocked.stats.unmatched,1);
    const zero=pack(algorithm,[.8,0,.2],10,.2);
    assert.deepEqual(zero.bins,[1,1,1]);
    assert.equal(zero.stats.ordinaryHardFills,1);
  }
});

test("only Simple uses the limit; Hard matches first or joins the ordinary pool", () => {
  for (const algorithm of ["two-layer-ff", "two-layer-bf"]) {
    const result = pack(algorithm, [.4,.4,.6,.6], 1);
    assert.deepEqual(result.bins, [1,2,1,2]);
    assert.equal(result.count, 2);
    assert.equal(result.stats.overflow, 1);
    assert.equal(result.stats.pairs, 1);
    assert.equal(result.stats.unmatched, 0);
    assert.equal(result.stats.ordinaryBins, 1);
    assert.equal(result.stats.peakReserved, 1);
    const onlySimple = pack(algorithm, [.4,.4,.4,.4], 2);
    assert.equal(onlySimple.count, 3); // Unmatched reservations count; no final repacking.
    assert.equal(onlySimple.stats.unmatched, 2);
  }
});

test("nearby non-atoms are not reserved, and the two ordinary variants differ correctly", () => {
  for (const algorithm of ["two-layer-ff", "two-layer-bf"]) {
    const result = pack(algorithm, [.4 - Number.EPSILON, .6 + Number.EPSILON]);
    assert.equal(result.stats.thresholdSimple, 0);
    assert.equal(result.stats.thresholdHard, 0);
    assert.equal(result.stats.pairs, 0);
    assert.equal(result.stats.ordinaryBins, result.count);
    const interleaved = pack(algorithm, [.4,.8,.6,.1]);
    assert.deepEqual(interleaved.bins, [1,2,1,2]);
    assert.equal(interleaved.count, 2);
  }
  assert.equal(pack("two-layer-ff", [.75,.8,.15,.24], 10, .3).count, 3);
  assert.equal(pack("two-layer-bf", [.75,.8,.15,.24], 10, .3).count, 2);
});

test("every job is placed causally; bins are feasible and reservations respect K", () => {
  const { packers } = load();
  for (const algorithm of ["two-layer-ff", "two-layer-bf"]) {
    for (const limit of [0,1,7,5000]) {
      const random = behavior.rng(89712), bins = [], stats = {}, jobs = [];
      function* arrivals() {
        for (let i=0;i<240;i++) {
          if (i>0) assert.ok(jobs[i-1].row.placementLayer, "previous job must be placed before the next arrives");
          const z = random(), hard = random()<.5;
          const job = { size: hard ? Math.max(.6,z) : Math.min(.4,z), hard, row:{} };
          jobs.push(job);
          yield job;
        }
      }
      // Capture all assignments here, including those after the 100-row UI limit.
      const sink = { length:0, push: bin => bins.push(bin) };
      const count = packers[algorithm](arrivals(), sink, undefined, 240,
        {simpleThreshold:.4,hardThreshold:.6,reservationLimit:limit},stats);
      assert.equal(bins.length,240);
      const contents = new Map();
      bins.forEach((bin,i) => { if (!contents.has(bin)) contents.set(bin,[]); contents.get(bin).push(jobs[i]); });
      assert.equal(contents.size,count);
      for (const group of contents.values()) {
        assert.ok(group.reduce((total,job)=>total+job.size,0)<=1+1e-12);
        if (group.some(job=>job.row.placementLayer.startsWith("Threshold"))) {
          assert.ok(group.length<=2);
          assert.equal(group[0].hard,false,"every reserved bin must be opened by a Simple job");
          assert.ok(group.every(job=>job.size===(job.hard?.6:.4)));
          if (group.length===2) assert.notEqual(group[0].hard,group[1].hard);
        }
      }
      assert.ok(stats.peakReserved<=limit);
      assert.ok(jobs.filter(job=>job.row.placementLayer==="Threshold Simple reservation · opened").every(job=>!job.hard));
      assert.equal(count,stats.pairs+stats.unmatched+stats.ordinaryBins);
      assert.equal(stats.ordinaryHardFills,jobs.filter(job=>job.row.placementLayer==="Ordinary Hard bin · filled before reservation").length);
      const expected=reference(jobs,algorithm,limit,.4);
      assert.equal(count,expected.count);
      assert.deepEqual(bins,expected.assignments);
    }
  }
});

test("validation requires complementary bounds and a bounded integer reservation limit", () => {
  const { validate } = load();
  assert.equal(validate(base).reservationLimit,10);
  for (const reservationLimit of [-1,.5,5001,NaN,Infinity]) assert.throws(()=>validate({...base,reservationLimit}),/Reservation limit/);
  for (const [simpleThreshold,hardThreshold] of [[.4,.61],[.4,.59],[0,1],[.5,.5],[.6,.4]]) {
    assert.throws(()=>validate({...base,simpleThreshold,hardThreshold}),/requires/);
  }
  assert.equal(validate({...base,simpleThreshold:.2,hardThreshold:.8,reservationLimit:0}).reservationLimit,0);
  assert.equal(validate({...base,algorithm:"first-fit",hardThreshold:.7}).algorithm,"first-fit");
});

test("full simulations preserve user feedback and compare ordinary packing on the same reports", async () => {
  const { validate, runSimulation, packers } = load();
  for (const [algorithm,ordinaryAlgorithm] of [["two-layer-ff","first-fit"],["two-layer-bf","best-fit"]]) {
    const ordinary=await runSimulation(validate({...base,algorithm:ordinaryAlgorithm}),()=>{},0);
    const layered=await runSimulation(validate({...base,algorithm}),()=>{},0);
    for (const key of ["trueCounts","feedbackTotals","finalRates"]) assert.deepEqual(Array.from(layered[key]),Array.from(ordinary[key]));
    assert.deepEqual(Array.from(layered.reportedBaselineCounts),Array.from(ordinary.reportedCounts));
    assert.deepEqual(Array.from(layered.firstRows,row=>[row.actual,row.perceived,row.hard,row.expectedBefore]),Array.from(ordinary.firstRows,row=>[row.actual,row.perceived,row.hard,row.expectedBefore]));
    assert.equal(layered.firstRows.length,100);
    for(const stats of layered.reservationTrials) assert.ok(stats.unmatched<=base.reservationLimit);
    assert.equal(layered.reportedCounts[0],layered.reservationTrials[0].pairs+layered.reservationTrials[0].unmatched+layered.reservationTrials[0].ordinaryBins);
    assert.equal(layered.reportedBaselineCounts[0],packers[ordinaryAlgorithm](layered.firstReportedSizes));
    const disabled=await runSimulation(validate({...base,algorithm,reservationLimit:0}),()=>{},0);
    assert.deepEqual(Array.from(disabled.reportedCounts),Array.from(ordinary.reportedCounts));
    assert.deepEqual(Array.from(disabled.firstRows,row=>row.reportedBin),Array.from(ordinary.firstRows,row=>row.reportedBin));
  }
});
