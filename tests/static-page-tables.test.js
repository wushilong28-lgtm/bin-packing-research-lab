const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function mount(page) {
  const html = fs.readFileSync(path.join(root, page), "utf8");
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size, `${page}: duplicate IDs`);
  const elements = new Map();
  for (const match of html.matchAll(/<([a-z][\w:-]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
    const value = match[0].match(/\bvalue="([^"]*)"/)?.[1] || "";
    elements.set(match[2], {
      value, checked: /\bchecked\b/.test(match[0]), textContent: "", innerHTML: "", hidden: false, disabled: false,
      listeners: new Map(), attributes: new Map(),
      addEventListener(name, callback) { this.listeners.set(name, callback); },
      setAttribute(name, value) { this.attributes.set(name, value); },
      removeAttribute(name) { this.attributes.delete(name); },
      getAttribute(name) { return this.attributes.get(name) ?? null; },
      dispatchEvent(event) { this.listeners.get(event.type)?.(event); },
    });
  }
  for (const match of html.matchAll(/<select\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
    const options = [...match[2].matchAll(/<option\b([^>]*)value="([^"]+)"[^>]*>/g)];
    elements.get(match[1]).value = (options.find(x => /\bselected\b/.test(x[0])) || options[0])?.[2] || "";
  }
  for (const match of html.matchAll(/<textarea\b[^>]*id="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) elements.get(match[1]).value = match[2];
  const button = { disabled: false, textContent: "", innerHTML: "" };
  for (const id of ["experiment-form", "green-form"]) if (elements.has(id)) elements.get(id).querySelector = () => button;
  const context = {
    window: {}, document: { getElementById: (id) => elements.get(id) || null },
    requestAnimationFrame: (callback) => setImmediate(callback),
  };
  return { elements, context };
}

async function waitForTable(elements) {
  const started = Date.now();
  while (!(elements.get("sample-table").innerHTML.match(/<tr>/g) || []).length && Date.now() - started < 5000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (!elements.get("form-error").hidden && elements.get("form-error").textContent) break;
  }
  assert.equal(elements.get("form-error").textContent, "");
  assert.equal((elements.get("sample-table").innerHTML.match(/<tr>/g) || []).length, 100);
}

test("basic page renders 100 first-trial jobs with both model bins", async () => {
  const { elements, context } = mount("index.html");
  elements.get("job-count").value = "500";
  elements.get("trial-count").value = "1";
  elements.get("random-seed").value = "";
  elements.get("packing-algorithm").value = "random-fit";
  elements.get("error-type").value = "normal";
  elements.get("probability-preset").value = "logistic";
  for (const file of ["probability.js", "static-behavior.js", "app.js"]) vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
  await waitForTable(elements);
  assert.match(elements.get("sample-table").innerHTML, /class="job-mode is-(?:hard|simple)"/);
  assert.match(elements.get("sample-table").innerHTML, /aria-expanded="false" aria-controls="job-details-1"/);
  assert.match(elements.get("sample-table").innerHTML, /class="job-detail-row" id="job-details-1" hidden/);
  assert.match(elements.get("sample-table").innerHTML, /Model 1 bin · true size/);
  assert.match(elements.get("sample-table").innerHTML, /Model 2 bin · report/);
});

test("basic page feedback switch enables c and renders the objective and job feedback", async () => {
  const { elements, context } = mount("index.html");
  elements.get("job-count").value = "500";
  elements.get("trial-count").value = "1";
  elements.get("random-seed").value = "";
  elements.get("packing-algorithm").value = "first-fit";
  elements.get("error-type").value = "none";
  elements.get("probability-expression").value = "0";
  elements.get("feedback-enabled").checked = true;
  elements.get("feedback-coefficient").value = "5";
  for (const file of ["probability.js", "static-behavior.js", "app.js"]) vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
  await waitForTable(elements);
  assert.equal(elements.get("feedback-coefficient").disabled, false);
  assert.match(elements.get("feedback-status").textContent, /Feedback on.*c = 5/);
  assert.ok(Number(elements.get("feedback-mean").textContent) > 0);
  assert.ok(Number(elements.get("objective-mean").textContent) > Number(elements.get("reported-mean").textContent));
  assert.match(elements.get("objective-comparison").innerHTML, /objective-feedback/);
  assert.match(elements.get("feedback-summary").textContent, /Perceived-size feedback/);
  elements.get("feedback-enabled").checked = false;
  elements.get("feedback-enabled").listeners.get("change")();
  assert.equal(elements.get("feedback-coefficient").disabled, true);
});

test("static Green page renders 100 first-trial jobs and switches algorithm bins", async () => {
  const { elements, context } = mount("green.html");
  elements.get("job-count").value = "120";
  elements.get("trial-count").value = "1";
  elements.get("error-type").value = "normal";
  elements.get("probability-preset").value = "logistic";
  elements.get("inspect-algorithm").value = "first-fit";
  for (const file of ["probability.js", "green-core.js", "green.js"]) vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
  await waitForTable(elements);
  elements.get("inspect-algorithm").value = "full-first-fit";
  elements.get("inspect-algorithm").listeners.get("change")();
  assert.equal((elements.get("sample-table").innerHTML.match(/<tr>/g) || []).length, 100);
  assert.match(elements.get("sample-table").innerHTML, /<td>\d+<\/td><\/tr>/);
});

test("basic page has one user, an active base probability, and feedback-dependent lambda controls", async () => {
  const {elements,context}=mount("index.html");
  elements.get("job-count").value="500";
  elements.get("trial-count").value="2";
  for(const file of ["probability.js","static-behavior.js","app.js"]) vm.runInNewContext(fs.readFileSync(path.join(root,file),"utf8"),context,{filename:file});
  await waitForTable(elements);
  assert.equal(elements.get("probability-controls").hidden,false);
  assert.equal(elements.get("probability-expression").disabled,false);
  assert.equal(elements.get("user-lambda").disabled,false);
  for(const id of ["users-enabled","user-count","user-thetas","learning-rate","learning-enabled","initial-feedback"]) assert.equal(elements.has(id),false);
  assert.equal((elements.get("user-memory-table").innerHTML.match(/<tr>/g)||[]).length,1);
  assert.match(elements.get("learning-status").textContent,/λ = 0.5/);
  assert.equal(elements.has("unit-price"),false);
  assert.equal(elements.has("payment-mean"),false);
  assert.equal((elements.get("learning-chart").innerHTML.match(/<path/g)||[]).length,3);
  assert.match(elements.get("sample-table").innerHTML,/Adjusted Hard probability/);
  assert.match(elements.get("sample-table").innerHTML,/q before → after/);
  assert.match(elements.get("size-histogram").innerHTML,/<rect/);
  elements.get("size-distribution").value="normal";
  elements.get("size-distribution").listeners.get("change")();
  assert.equal(elements.get("distribution-uniform").hidden,true);
  assert.equal(elements.get("size-min").disabled,true);
  assert.equal(elements.get("distribution-normal").hidden,false);
  assert.equal(elements.get("size-mean").disabled,false);
  elements.get("feedback-enabled").checked=false;
  elements.get("feedback-enabled").listeners.get("change")();
  assert.equal(elements.get("user-lambda").disabled,true);
  assert.equal(elements.get("feedback-coefficient").disabled,true);
  assert.equal(elements.get("probability-expression").disabled,false);
  elements.get("feedback-enabled").checked=true;
  elements.get("feedback-enabled").listeners.get("change")();
  assert.equal(elements.get("user-lambda").disabled,false);
});
test("browser tool runs the same one-user model and updates feedback controls and results", async () => {
  const {elements,context}=mount("index.html");
  elements.get("job-count").value="500";elements.get("trial-count").value="1";
  let registered;
  context.document.modelContext={registerTool:tool=>{registered=tool;}};
  context.Event=class {constructor(type){this.type=type;}};
  for(const file of ["probability.js","static-behavior.js","app.js"]) vm.runInNewContext(fs.readFileSync(path.join(root,file),"utf8"),context,{filename:file});
  await waitForTable(elements);
  assert.equal(registered.inputSchema.properties.unitPrice,undefined);
  assert.equal(registered.inputSchema.properties.lambda.minimum,0);
  assert.equal(registered.inputSchema.properties.lambda.maximum,1);
  const settings={jobs:500,trials:1,algorithm:"first-fit",probabilityExpression:"0",simpleThreshold:.2,hardThreshold:.7,errorType:"none",errorScale:0,lambda:1,sizeMin:.8,sizeMax:.9,seed:"12345",feedbackEnabled:true};
  const on=await registered.execute(settings);
  assert.equal(on.paymentMean,undefined);
  assert.equal(on.userCount,1);assert.equal(on.hardShare,499/500);assert.equal(on.finalRateMean,1);
  assert.equal(elements.get("user-lambda").value,1);
  const off=await registered.execute({...settings,feedbackEnabled:false});
  assert.equal(off.hardShare,0);assert.equal(off.finalRateMean,0);assert.equal(off.feedbackMean,0);
  assert.equal(off.reportedMean,100);
  assert.equal(elements.get("user-lambda").disabled,true);
  assert.match(elements.get("learning-status").textContent,/Feedback off/);
});

test("two-layer choices expose K, complement bounds explicitly, and render pairing diagnostics", async () => {
  const {elements,context}=mount("index.html");
  elements.get("job-count").value="500"; elements.get("trial-count").value="1";
  let registered;
  context.document.modelContext={registerTool:tool=>{registered=tool;}};
  context.Event=class {constructor(type){this.type=type;}};
  for(const file of ["probability.js","static-behavior.js","app.js"]) vm.runInNewContext(fs.readFileSync(path.join(root,file),"utf8"),context,{filename:file});
  await waitForTable(elements);
  assert.equal(elements.get("reservation-controls").hidden,true);
  assert.equal(elements.get("reservation-limit").disabled,true);
  elements.get("packing-algorithm").value="two-layer-ff";
  elements.get("packing-algorithm").listeners.get("change")();
  assert.equal(elements.get("reservation-controls").hidden,false);
  assert.equal(elements.get("reservation-limit").disabled,false);
  assert.match(elements.get("complementary-status").textContent,/Set h to 0.8/);
  elements.get("complementary-bounds").listeners.get("click")();
  assert.equal(elements.get("hard-threshold").value,.8);
  assert.match(elements.get("complementary-status").textContent,/ready/);
  assert.ok(registered.inputSchema.properties.algorithm.enum.includes("two-layer-bf"));
  for(const algorithm of ["two-layer-ff","two-layer-bf"]) {
    const result=await registered.execute({jobs:500,trials:1,algorithm,reservationLimit:7,probabilityExpression:"0.5",simpleThreshold:.2,hardThreshold:.8,errorType:"none",errorScale:0,seed:"20261029",feedbackEnabled:true});
    assert.equal(result.reservationLimit,7);
    assert.ok(result.reservationMeans.pairs>0);
    assert.equal(elements.get("two-layer-results").hidden,false);
    assert.match(elements.get("two-layer-summary").textContent,/K = 7.*Matched pairs/);
    assert.match(elements.get("two-layer-summary").textContent,/Simple-only reservations.*Hard is never reserved/);
    assert.match(elements.get("algorithm-description").textContent,/first places threshold Simple.*existing ordinary Hard bin/);
    assert.match(elements.get("two-layer-summary").textContent,/Simple placed in existing ordinary Hard bins/);
    assert.ok(result.reservationMeans.ordinaryHardFills>0);
    assert.match(elements.get("two-layer-comparison").textContent,/Same reported jobs/);
    assert.match(elements.get("comparison-rule").textContent,/Model 1 packs true sizes using ordinary/);
    assert.match(elements.get("sample-table").innerHTML,/Placement route at arrival/);
  }
  elements.get("packing-algorithm").value="best-fit";
  elements.get("packing-algorithm").listeners.get("change")();
  assert.equal(elements.get("reservation-controls").hidden,true);
  assert.equal(elements.get("reservation-limit").disabled,true);
});
