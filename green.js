(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const form = $("green-form");
  const runButton = form.querySelector("button[type=submit]");
  const engine = window.GreenPacking;
  const errorTypes = new Set(["none", "normal", "uniform", "laplace", "triangular", "cauchy", "exponential", "two-point"]);
  const probabilityPresets = {
    logistic: "1/(1+exp(-12*(z-0.5)))",
    decreasing: "1-z",
    increasing: "z",
    constant: "0.5",
    step: "step(z-0.5)",
  };
  let runSequence = 0;
  let lastResult = null;

  function parseSettings() {
    const settings = {
      jobs: Number($("job-count").value),
      trials: Number($("trial-count").value),
      seed: Number($("random-seed").value),
      errorType: $("error-type").value,
      errorScale: Number($("error-scale").value),
      probabilityExpression: $("probability-expression").value,
      simpleThreshold: Number($("simple-threshold").value),
      hardThreshold: Number($("hard-threshold").value),
      greenCapacity: Number($("green-capacity").value),
      blackPrice: Number($("black-price").value),
      threshold: Number($("packing-threshold").value),
    };
    const checks = [
      [Number.isInteger(settings.jobs) && settings.jobs >= 1 && settings.jobs <= 5000, "Jobs per trial must be an integer from 1 to 5000."],
      [Number.isInteger(settings.trials) && settings.trials >= 1 && settings.trials <= 100, "Trials must be an integer from 1 to 100."],
      [Number.isInteger(settings.seed) && settings.seed >= 0 && settings.seed <= 4294967295, "Random seed must be an integer from 0 to 4294967295."],
      [errorTypes.has(settings.errorType), "Choose a supported error distribution."],
      [Number.isFinite(settings.errorScale) && settings.errorScale >= 0 && settings.errorScale <= 1, "Error scale must be between 0 and 1."],
      [Number.isFinite(settings.simpleThreshold) && settings.simpleThreshold >= 0 && settings.simpleThreshold <= 1, "Simple upper bound must be between 0 and 1."],
      [Number.isFinite(settings.hardThreshold) && settings.hardThreshold >= 0 && settings.hardThreshold <= 1, "Hard lower bound must be between 0 and 1."],
      [Number.isFinite(settings.greenCapacity) && settings.greenCapacity >= 0 && settings.greenCapacity <= 1, "Green capacity G must be between 0 and 1."],
      [Number.isFinite(settings.blackPrice) && settings.blackPrice > 0 && settings.blackPrice <= 100, "Black-space price β must be greater than 0 and at most 100."],
      [Number.isFinite(settings.threshold) && settings.threshold >= 0 && settings.threshold <= 1 - settings.greenCapacity + 1e-12, "Threshold τ must be between 0 and 1 − G."],
    ];
    const failed = checks.find(([valid]) => !valid);
    if (failed) throw new Error(failed[1]);
    settings.probability = window.compileProbabilityExpression(settings.probabilityExpression);
    settings.effectiveCapacity = Math.min(1, settings.greenCapacity + settings.threshold);
    return settings;
  }

  const format = (number, places = 2) => number.toFixed(places);

  async function simulate(settings, onProgress, runId) {
    const random = engine.seededRandom(settings.seed);
    const algorithms = [...engine.ALGORITHMS, "full-first-fit"];
    const totals = Object.fromEntries(algorithms.map((name) => [name, { total: 0, openingCost: 0, blackCost: 0, blackVolume: 0, bins: 0 }]));
    let firstSample = null;
    const firstAssignments = {};
    for (let trial = 0; trial < settings.trials; trial += 1) {
      const sample = engine.sampleTrial(settings, settings.probability, random);
      if (trial === 0) firstSample = sample;
      for (const algorithm of algorithms) {
        const baseline = algorithm === "full-first-fit";
        const assignments = trial === 0 ? [] : null;
        const loads = engine.pack(sample.reported, baseline ? "first-fit" : algorithm, baseline ? 1 : settings.effectiveCapacity, 10, assignments);
        const outcome = engine.cost(loads, settings.greenCapacity, settings.blackPrice);
        for (const key of Object.keys(totals[algorithm])) totals[algorithm][key] += outcome[key];
        if (trial === 0) firstAssignments[algorithm] = assignments;
      }
      if (runId !== runSequence) throw new Error("A newer experiment has replaced this run.");
      onProgress(trial + 1, settings.trials);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    for (const algorithm of algorithms) {
      for (const key of Object.keys(totals[algorithm])) totals[algorithm][key] /= settings.trials;
    }
    return { settings, totals, firstSample, firstAssignments };
  }

  function drawProbabilityCurve() {
    const left = 29, right = 309, top = 8, bottom = 101;
    const axes = `<line x1="${left}" y1="${top}" x2="${left}" y2="${bottom}" stroke="#b9cbc9"/><line x1="${left}" y1="${bottom}" x2="${right}" y2="${bottom}" stroke="#b9cbc9"/><line x1="${left}" y1="54.5" x2="${right}" y2="54.5" stroke="#e3ebea" stroke-dasharray="4 4"/><g fill="#82999b" font-size="11" font-family="system-ui,sans-serif"><text x="2" y="13">1</text><text x="7" y="104">0</text><text x="${left}" y="118" text-anchor="middle">0</text><text x="${right}" y="118" text-anchor="middle">1</text><text x="${(left + right) / 2}" y="118" text-anchor="middle">Perceived size z</text></g>`;
    let probability;
    try {
      probability = window.compileProbabilityExpression($("probability-expression").value);
      $("curve-error").hidden = true;
      $("curve-error").textContent = "";
    } catch (error) {
      $("curve-error").textContent = error.message;
      $("curve-error").hidden = false;
      $("probability-chart").innerHTML = axes;
      return;
    }
    let path = "";
    for (let i = 0; i <= 100; i += 1) {
      const perceived = i / 100;
      const x = left + perceived * (right - left);
      const y = bottom - probability(perceived) * (bottom - top);
      path += `${i ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)} `;
    }
    $("probability-chart").innerHTML = `${axes}<path d="${path}" fill="none" stroke="#0b8095" stroke-width="3" stroke-linecap="round"/>`;
  }

  function updateErrorDescription() {
    const descriptions = {
      none: ["", "No judgment error is added."],
      normal: ["Standard deviation σ", "Normal distribution: ε ~ N(0, σ²)."],
      uniform: ["Half-width h", "Uniform distribution: ε ~ Uniform(-h, h)."],
      laplace: ["Scale b", "Laplace distribution: centered at 0 with scale b."],
      triangular: ["Half-width h", "Symmetric triangular distribution: ε lies in [-h, h] and is concentrated near 0."],
      cauchy: ["Scale γ", "Cauchy distribution: centered at 0 with heavy tails."],
      exponential: ["Scale b", "Centered exponential: ε = b(X − 1), X ~ Exp(1); right-skewed."],
      "two-point": ["Magnitude d", "Two-point distribution: ε is equally likely to be -d or +d."],
    };
    const type = $("error-type").value;
    $("error-scale-field").hidden = type === "none";
    $("error-scale-label").textContent = descriptions[type][0];
    $("error-description").textContent = `${descriptions[type][1]} Clip a + ε to [0, 1] to obtain z before selecting a mode.`;
  }

  function updateRegime() {
    const green = Number($("green-capacity").value);
    const price = Number($("black-price").value);
    const threshold = Number($("packing-threshold").value);
    if (![green, price, threshold].every(Number.isFinite) || green < 0 || green > 1 || price <= 0 || threshold < 0 || threshold > 1 - green + 1e-12) {
      $("regime-note").textContent = "Choose 0 ≤ G ≤ 1, β > 0, and 0 ≤ τ ≤ 1 − G.";
      return;
    }
    const effective = Math.min(1, green + threshold);
    const regime = price * green <= 1 ? `βG = ${format(price * green)} ≤ 1: the paper's full-capacity threshold is τ = ${format(1 - green)}.` : `βG = ${format(price * green)} > 1: expensive black space makes τ worth tuning.`;
    $("regime-note").textContent = `Effective capacity G + τ = ${format(effective)}. ${regime}`;
  }

  function render(result) {
    lastResult = result;
    const { settings, totals } = result;
    const ordered = [...engine.ALGORITHMS].sort((a, b) => totals[a].total - totals[b].total);
    const bestName = ordered[0];
    const best = totals[bestName];
    $("best-cost").textContent = format(best.total);
    $("best-opening").textContent = format(best.openingCost);
    $("best-black").textContent = format(best.blackCost);
    $("best-algorithm").textContent = `${engine.LABELS[bestName]} · mean per trial`;
    $("run-badge").textContent = `${settings.jobs} jobs × ${settings.trials} trials · seed ${settings.seed}`;
    const rows = [...ordered, "full-first-fit"];
    const maxCost = Math.max(...rows.map((name) => totals[name].total));
    $("cost-chart").innerHTML = rows.map((name) => {
      const entry = totals[name];
      const label = name === "full-first-fit" ? "First Fit · full" : engine.LABELS[name];
      const openingWidth = 100 * entry.openingCost / maxCost;
      const blackWidth = 100 * entry.blackCost / maxCost;
      return `<div class="cost-row${name === "full-first-fit" ? " reference-row" : ""}"><span class="cost-name">${label}</span><div class="cost-track"><span class="cost-opening" style="width:${openingWidth}%"></span><span class="cost-black" style="width:${blackWidth}%"></span></div><strong>${format(entry.total)}</strong></div>`;
    }).join("");
    $("cost-chart").setAttribute("aria-label", rows.map((name) => `${name === "full-first-fit" ? "Full-capacity First Fit" : engine.LABELS[name]} mean total cost ${format(totals[name].total)}`).join("; "));
    $("results-table").innerHTML = rows.map((name) => {
      const entry = totals[name];
      const label = name === "full-first-fit" ? "First Fit · full" : engine.LABELS[name];
      return `<tr${name === "full-first-fit" ? ' class="reference-row"' : ""}><th scope="row">${label}</th><td>${format(entry.total)}</td><td>${format(entry.bins, 1)}</td><td>${format(entry.blackVolume, 2)}</td></tr>`;
    }).join("");
    renderSampleTable(result, $("inspect-algorithm").value);
  }

  function renderSampleTable(result, algorithm) {
    const { firstSample, firstAssignments, settings } = result;
    const assignments = firstAssignments[algorithm];
    $("sample-table").innerHTML = Array.from({ length: Math.min(100, firstSample.actual.length) }, (_, index) => {
      const actual = firstSample.actual[index];
      const perceived = firstSample.perceived[index];
      const reported = firstSample.reported[index];
      return `<tr><th scope="row">${index + 1}</th><td>${format(actual, 3)}</td><td>${format(perceived, 3)}</td><td>${format(100 * settings.probability(perceived), 1)}%</td><td>${firstSample.hardModes[index] ? "Hard" : "Simple"}</td><td>${format(reported, 3)}</td><td>${assignments[index]}</td></tr>`;
    }).join("");
  }

  async function executeFromForm() {
    let settings;
    try { settings = parseSettings(); }
    catch (error) { $("form-error").textContent = error.message; $("form-error").hidden = false; return; }
    $("form-error").hidden = true;
    const runId = ++runSequence;
    const previousBadge = $("run-badge").textContent;
    runButton.disabled = true;
    runButton.textContent = "Calculating…";
    $("run-badge").setAttribute("aria-busy", "true");
    try {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const result = await simulate(settings, (done, total) => { $("run-badge").textContent = `Calculating ${done} / ${total}`; }, runId);
      render(result);
    } catch (error) {
      if (runId === runSequence) {
        $("run-badge").textContent = previousBadge;
        $("form-error").textContent = error.message || "The experiment failed. Please try again.";
        $("form-error").hidden = false;
      }
    } finally {
      if (runId === runSequence) {
        runButton.disabled = false;
        runButton.innerHTML = '<span aria-hidden="true">▶</span> Run green experiment';
        $("run-badge").removeAttribute("aria-busy");
      }
    }
  }

  form.addEventListener("submit", (event) => { event.preventDefault(); executeFromForm(); });
  $("inspect-algorithm").addEventListener("change", () => { if (lastResult) renderSampleTable(lastResult, $("inspect-algorithm").value); });
  $("advanced-toggle").addEventListener("click", () => {
    const expanded = $("advanced-toggle").getAttribute("aria-expanded") !== "true";
    $("advanced-toggle").setAttribute("aria-expanded", String(expanded));
    $("advanced-toggle").textContent = expanded ? "Fewer settings" : "More settings";
    document.querySelector(".controls").classList.toggle("expanded", expanded);
  });
  $("probability-preset").addEventListener("change", () => {
    const expression = probabilityPresets[$("probability-preset").value];
    if (expression) $("probability-expression").value = expression;
    drawProbabilityCurve();
  });
  $("probability-expression").addEventListener("input", () => {
    $("probability-preset").value = Object.entries(probabilityPresets).find(([, expression]) => expression === $("probability-expression").value)?.[0] ?? "custom";
    drawProbabilityCurve();
  });
  $("error-type").addEventListener("change", updateErrorDescription);
  ["green-capacity", "black-price", "packing-threshold"].forEach((id) => $(id).addEventListener("input", updateRegime));
  drawProbabilityCurve();
  updateErrorDescription();
  updateRegime();
  executeFromForm();
})();
