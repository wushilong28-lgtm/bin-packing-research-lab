const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const core = require("../static-behavior.js");
const root = path.resolve(__dirname, "..");
const source = fs.readFileSync(path.join(root, "app.js"), "utf8");
const simulationSource = source.slice(source.indexOf("  const errorTypes ="), source.indexOf("  function drawProbabilityCurve()"));
const base = { jobs: 500, trials: 1, algorithm: "first-fit", probabilityExpression: "0.5", simpleThreshold: 0.2, hardThreshold: 0.7, errorType: "none", errorScale: 0, feedbackEnabled: true, feedbackCoefficient: 1, lambda: .5, seed: "12345" };
function load() {
  const context = { window: { StaticBehavior: core }, Math, requestAnimationFrame: cb => cb() };
  vm.runInNewContext(fs.readFileSync(path.join(root, "probability.js"), "utf8"), context);
  return vm.runInNewContext(simulationSource + "\n({ runSimulation, validate, packers });", context);
}
async function run(overrides = {}) {
  const { runSimulation, validate } = load();
  return runSimulation(validate({ ...base, ...overrides }), () => {}, 0);
}
function near(a, b, tolerance = 1e-9) { assert.ok(Math.abs(a-b) < tolerance, `${a} differs from ${b}`); }

test("bounded distributions have the expected distinct means and no Gaussian clipping atoms", () => {
  const cases = [
    ["uniform", {sizeMin:.2,sizeMax:.8}, .5],
    ["normal", {sizeMean:.5,sizeStd:.15}, .5],
    ["beta", {betaAlpha:2,betaBeta:5}, 2/7],
    ["beta", {betaAlpha:.1,betaBeta:.1}, .5],
    ["exponential", {sizeRate:3}, 1/3-1/Math.expm1(3)],
    ["bimodal", {mixtureWeight:.25}, .625],
  ];
  for (const [sizeDistribution, params, expected] of cases) {
    const s = core.settings({...base,sizeDistribution,...params}), random=core.rng(76431);
    let sum=0, atBoundary=0;
    for (let i=0;i<30000;i++) {
      const x=core.sampleSize(s,random);
      assert.ok(Number.isFinite(x) && x>=0 && x<=1, `${sizeDistribution}: invalid size`);
      sum+=x; atBoundary+=Number(x===0 || x===1);
    }
    near(sum/30000,expected,.009);
    if (sizeDistribution === "normal") assert.equal(atBoundary,0);
  }
});

test("one-user probability feedback has the expected values and respects both boundaries", () => {
  const user=core.createUser({...core.defaults,lambda:.5});
  near(user.q,0);
  near(core.chooseMode(user,.2,true,.3).hardProbability,.2);
  user.q=.5;
  const decision=core.chooseMode(user,.2,true,.39);
  near(decision.hardProbability,.4);
  assert.equal(decision.hard,true);
  assert.equal(core.chooseMode(user,.2,true,.4).hard,false);
  for(const lambda of [0,.25,.5,1]) for(const q of [0,.2,1]) for(const p of [0,.2,.5,1]) {
    const u={...user,lambda,q};
    const d=core.chooseMode(u,p,true,.5);
    assert.ok(d.hardProbability>=p && d.hardProbability<=1);
    near(core.chooseMode(u,p,false,.5).hardProbability,p);
    if(lambda===0 || q===0) near(d.hardProbability,p);
  }
  near(core.chooseMode({...user,lambda:1,q:1},0,true,.999).hardProbability,1);
});

test("Simple success and failure update the empirical rate; Hard never enters the denominator", () => {
  const user=core.createUser({...core.defaults,lambda:.5});
  const outcome=(hard,fail,feedback)=>({hard,qualityFailed:fail,feedback});
  core.receiveFeedback(user,outcome(false,true,0),true);
  near(user.q,1); assert.equal(user.observedSimple,1);
  core.receiveFeedback(user,outcome(true,false,0),true);
  near(user.q,1); assert.equal(user.observedSimple,1);
  core.receiveFeedback(user,outcome(false,false,0),true);
  near(user.q,.5); assert.equal(user.observedSimple,2);
  core.receiveFeedback(user,outcome(false,true,100),true);
  near(user.q,2/3); assert.equal(user.failures,2);
  assert.equal(user.submissions,4);
});

test("streamed single-user reports match independent packers and respect capacity", async () => {
  function reference(sizes,algorithm) {
    const remaining=[],assignment=[];
    for(const x of sizes) {
      let i=-1;
      if(algorithm==="next-fit") {
        const last=remaining.length-1;
        if(last>=0 && remaining[last]+1e-12>=x)i=last;
      } else if(algorithm==="first-fit") i=remaining.findIndex(r=>r+1e-12>=x);
      else {
        let best=Infinity;
        remaining.forEach((r,k)=>{if(r+1e-12>=x && r<best){best=r;i=k;}});
      }
      if(i<0){i=remaining.length;remaining.push(1);}
      remaining[i]-=x;assignment.push(i+1);
      assert.ok(remaining[i]>=-1e-10);
    }
    return {count:remaining.length,assignment};
  }
  for(const algorithm of ["first-fit","best-fit","next-fit","random-fit"]) {
    const r=await run({algorithm,trials:2});
    assert.equal(r.firstReportedSizes.length,500);
    if(algorithm!=="random-fit") {
      const ref=reference(r.firstReportedSizes,algorithm);
      assert.equal(r.reportedCounts[0],ref.count);
      assert.deepEqual(Array.from(r.firstRows,row=>row.reportedBin),ref.assignment.slice(0,100));
    } else {
      const {packers}=load(), assignments=[];
      const seed=((12345+Math.imul(1,0x9e3779b9))>>>0)^0xc7c7c7c7;
      const count=packers[algorithm](r.firstReportedSizes,assignments,core.rng(seed));
      assert.equal(r.reportedCounts[0],count);
      assert.deepEqual(Array.from(r.firstRows,row=>row.reportedBin),Array.from(assignments));
    }
  }
});

test("each mode draw uses only earlier feedback and the current base probability", async () => {
  const r=await run({lambda:.6,trials:2,errorType:"uniform",errorScale:.2});
  let q=0, observed=0, failures=0;
  for(const row of r.firstRows) {
    assert.equal(row.userId,1); assert.equal(row.submission,row.id);
    near(row.expectedBefore,q);
    near(row.baseProbability,.5);
    near(row.hardProbability,.5+.6*q*.5);
    assert.equal(row.hard,row.draw<row.hardProbability);
    near(row.reported,row.hard?Math.max(.7,row.perceived):Math.min(.2,row.perceived));
    const failed=!row.hard && row.perceived>row.reported;
    assert.equal(row.qualityFailed,failed);
    if(!row.hard){observed++;failures+=Number(failed);q=failures/observed;}
    near(row.expectedAfter,q);
    assert.equal(row.observedSimple,observed); assert.equal(row.failures,failures);
  }
  assert.equal(r.firstUser.submissions,500);
  assert.equal(r.userTotals.jobs,1000);
  assert.equal(r.rounds.length,500);
  assert.equal(r.rounds.reduce((n,b)=>n+b.jobs,0),1000);
});

test("feedback off restores g0 and disables all history and penalties; lambda zero keeps g0 but still records outcomes", async () => {
  const off=await run({feedbackEnabled:false,lambda:1});
  const inert=await run({lambda:0});
  const on=await run({lambda:.8});
  off.firstRows.forEach(row=>{
    near(row.hardProbability,row.baseProbability);near(row.expectedBefore,0);near(row.expectedAfter,0);
    near(row.feedback,0);assert.equal(row.observedSimple,0);assert.equal(row.qualityFailed,false);
  });
  near(off.objectiveMean,off.reportedMean);
  assert.equal(off.firstUser.observedSimple,0);
  assert.deepEqual(Array.from(off.firstRows,r=>r.hard),Array.from(inert.firstRows,r=>r.hard));
  assert.deepEqual(Array.from(off.reportedCounts),Array.from(inert.reportedCounts));
  assert.ok(inert.firstUser.observedSimple>0);
  assert.ok(inert.feedbackMean>0);
  assert.ok(on.firstRows.some(row=>row.hardProbability>row.baseProbability));
});

test("coefficient c changes only the objective penalty, including zero c", async () => {
  for(const algorithm of ["first-fit","best-fit","next-fit","random-fit"]) {
    const baseline=await run({algorithm,lambda:.5,trials:2});
    for(const c of [0,5]) {
      const r=await run({algorithm,lambda:.5,trials:2,feedbackCoefficient:c});
      assert.deepEqual(Array.from(r.firstRows,row=>[row.actual,row.perceived,row.hard,row.hardProbability,row.reportedBin,row.expectedAfter]),Array.from(baseline.firstRows,row=>[row.actual,row.perceived,row.hard,row.hardProbability,row.reportedBin,row.expectedAfter]));
      assert.deepEqual(Array.from(r.reportedCounts),Array.from(baseline.reportedCounts));
      near(r.feedbackMean,baseline.feedbackMean*c);
      near(r.firstUser.q,baseline.firstUser.q);
      near(r.objectiveMean,r.reportedMean+r.feedbackMean);
      if(c===0) assert.ok(r.firstRows.some(row=>row.qualityFailed));
    }
  }
});

test("private Hard bounds do not enter probability decisions", async () => {
  const baseline=await run({lambda:.7});
  for(const changes of [{hardThreshold:.9},{hardThreshold:0}]) {
    const r=await run({...changes,lambda:.7});
    assert.deepEqual(Array.from(r.firstRows,row=>[row.hard,row.hardProbability,row.expectedBefore,row.expectedAfter]),Array.from(baseline.firstRows,row=>[row.hard,row.hardProbability,row.expectedBefore,row.expectedAfter]));
  }
});

test("fixed-seed exogenous inputs are preserved when algorithm, lambda or feedback changes", async () => {
  const baseline=await run({sizeDistribution:"beta"});
  for(const changes of [{algorithm:"random-fit"},{lambda:0},{lambda:1},{feedbackEnabled:false},{feedbackCoefficient:5}]) {
    const r=await run({...changes,sizeDistribution:"beta"});
    assert.deepEqual(Array.from(r.firstSizes),Array.from(baseline.firstSizes));
    assert.deepEqual(Array.from(r.firstRows,row=>[row.perceived,row.draw]),Array.from(baseline.firstRows,row=>[row.perceived,row.draw]));
  }
  const repeated=await run({sizeDistribution:"beta"});
  assert.deepEqual(Array.from(repeated.firstRows,row=>[row.hard,row.reportedBin,row.feedback]),Array.from(baseline.firstRows,row=>[row.hard,row.reportedBin,row.feedback]));
});

test("every independent trial starts with q=0 and all jobs enter the totals", async () => {
  const two=await run({trials:2,lambda:.8});
  const second=await run({lambda:.8,seed:String((12345+0x9e3779b9)>>>0)});
  near(two.reportedCounts[1],second.reportedCounts[0]);
  near(two.feedbackTotals[1],second.feedbackTotals[0]);
  near(two.finalRates[1],second.firstUser.q);
  near(two.rounds[0].qBefore,0);
  assert.equal(two.firstRows.length,100);
  assert.equal(two.firstUser.submissions,500);
  near(two.firstUser.feedback,two.feedbackTotals[0]);
  near(two.finalRateMean,(two.finalRates[0]+two.finalRates[1])/2);
});

test("lambda one can saturate at Hard probability one, without inventing Simple observations", async () => {
  const r=await run({lambda:1,probabilityExpression:"0",sizeMin:.8,sizeMax:.9});
  assert.equal(r.firstRows[0].hard,false);
  near(r.firstRows[0].expectedBefore,0);
  r.firstRows.slice(1).forEach(row=>{assert.equal(row.hard,true);near(row.hardProbability,1);});
  assert.equal(r.firstUser.observedSimple,1);assert.equal(r.firstUser.failures,1);
  assert.equal(r.firstUser.hardCount,499);near(r.firstUser.q,1);
  const allHard=await run({lambda:1,probabilityExpression:"1"});
  assert.equal(allHard.firstUser.observedSimple,0);near(allHard.firstUser.q,0);
});

test("invalid lambda, distribution, seed and base probabilities are rejected", () => {
  const {validate}=load();
  for(const overrides of [
    {lambda:-.01},{lambda:1.01},{lambda:NaN},{lambda:Infinity},
    {sizeDistribution:"unknown"},{sizeMin:.8,sizeMax:.2},{sizeDistribution:"normal",sizeStd:0},
    {sizeDistribution:"beta",betaAlpha:0},{sizeDistribution:"exponential",sizeRate:0},
    {sizeDistribution:"bimodal",mixtureLow:.8,mixtureHigh:.2},
    {seed:"-1"},{seed:"4294967296"},{probabilityExpression:"invalid expression"},
  ]) assert.throws(()=>validate({...base,...overrides}),JSON.stringify(overrides));
  assert.doesNotThrow(()=>validate({...base,lambda:0}));
  assert.doesNotThrow(()=>validate({...base,lambda:1}));
  assert.doesNotThrow(()=>validate({...base,lambda:.3333333333}));
});

test("shortfall history uses perceived size and ignores alpha magnitude", async () => {
  const r=await run({lambda:0,probabilityExpression:"0",errorType:"uniform",errorScale:1,feedbackCoefficient:0});
  let failures=0;
  for(const row of r.firstRows) {
    failures+=Number(row.perceived>.2);
    assert.equal(row.qualityFailed,row.perceived>.2);
    assert.equal(row.failures,failures);assert.equal(row.observedSimple,row.id);
    near(row.expectedAfter,failures/row.id);near(row.feedback,0);
  }
  assert.ok(r.firstRows.some(row=>row.actual>.2 && row.perceived<=.2));
});
