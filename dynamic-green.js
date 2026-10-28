(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const form = $("dynamic-form");
  const runButton = form.querySelector("button[type=submit]");
  const engine = window.DynamicGreen;
  const algorithms = [...engine.ALGORITHMS, "full-first-fit"];
  const presets = {
    logistic: "1/(1+exp(-12*(z-0.5)))", increasing: "z", decreasing: "1-z",
    constant: "0.5", step: "step(z-0.5)",
  };
  const errorTypes = new Set(["none", "normal", "uniform", "laplace", "triangular", "cauchy", "exponential", "two-point"]);
  let runSequence = 0;
  let lastResult = null;

  function readSettings() {
    const value = (id) => Number($(id).value);
    const settings = {
      jobs: value("job-count"), trials: value("trial-count"), seed: value("random-seed"),
      arrivalPattern: $("arrival-pattern").value, arrivalInterval: value("arrival-interval"),
      durationMin: value("duration-min"), durationMax: value("duration-max"),
      errorType: $("error-type").value, errorScale: value("error-scale"),
      durationError: value("duration-error") / 100, timeWeight: value("time-weight"),
      probabilityExpression: $("probability-expression").value,
      durationMidpoint: value("duration-midpoint"), durationWidth: value("duration-width"),
      simpleSize: value("simple-size"), hardSize: value("hard-size"),
      simpleDuration: value("simple-duration"), hardDuration: value("hard-duration"),
      greenCapacity: value("green-capacity"), blackPrice: value("black-price"),
      threshold: value("packing-threshold"), categoryWidth: value("category-width"),
    };
    const checks = [
      [Number.isInteger(settings.jobs) && settings.jobs >= 1 && settings.jobs <= 1000, "Jobs per trial must be 1–1000."],
      [Number.isInteger(settings.trials) && settings.trials >= 1 && settings.trials <= 30, "Trials must be 1–30."],
      [Number.isInteger(settings.seed) && settings.seed >= 0 && settings.seed <= 4294967295, "Seed must be an integer from 0 to 4294967295."],
      [["fixed", "exponential"].includes(settings.arrivalPattern), "Choose a valid arrival pattern."],
      [Number.isFinite(settings.arrivalInterval) && settings.arrivalInterval >= 0.01 && settings.arrivalInterval <= 1000, "Arrival interval must be 0.01–1000 hours."],
      [Number.isFinite(settings.durationMin) && settings.durationMin >= 0.01 && settings.durationMin <= 1000, "Minimum duration must be 0.01–1000 hours."],
      [Number.isFinite(settings.durationMax) && settings.durationMax >= settings.durationMin && settings.durationMax <= 1000, "Maximum duration must be at least the minimum and at most 1000 hours."],
      [errorTypes.has(settings.errorType) && Number.isFinite(settings.errorScale) && settings.errorScale >= 0 && settings.errorScale <= 1, "Choose a supported size error and scale from 0 to 1."],
      [Number.isFinite(settings.durationError) && settings.durationError >= 0 && settings.durationError <= 0.99, "Duration error must be 0–99%."],
      [Number.isFinite(settings.timeWeight) && settings.timeWeight >= 0 && settings.timeWeight <= 1, "Duration weight must be from 0 to 1."],
      [Number.isFinite(settings.durationMidpoint) && settings.durationMidpoint > 0 && settings.durationMidpoint <= 1000, "Duration midpoint must be positive and at most 1000 hours."],
      [Number.isFinite(settings.durationWidth) && settings.durationWidth > 0 && settings.durationWidth <= 1000, "Transition width must be positive and at most 1000 hours."],
      [Number.isFinite(settings.simpleSize) && settings.simpleSize >= 0 && settings.simpleSize <= 1, "Simple size cap must be from 0 to 1."],
      [Number.isFinite(settings.hardSize) && settings.hardSize >= 0 && settings.hardSize <= 1, "Hard size floor must be from 0 to 1."],
      [Number.isFinite(settings.simpleDuration) && settings.simpleDuration >= 0.01 && settings.simpleDuration <= 1000, "Simple duration cap must be 0.01–1000 hours."],
      [Number.isFinite(settings.hardDuration) && settings.hardDuration >= 0.01 && settings.hardDuration <= 1000, "Hard duration floor must be 0.01–1000 hours."],
      [Number.isFinite(settings.greenCapacity) && settings.greenCapacity >= 0 && settings.greenCapacity <= 1, "Green capacity G must be from 0 to 1."],
      [Number.isFinite(settings.blackPrice) && settings.blackPrice > 0 && settings.blackPrice <= 100, "Black-space price β must be positive and at most 100."],
      [Number.isFinite(settings.threshold) && settings.threshold >= 0 && settings.threshold <= 1 - settings.greenCapacity + 1e-12, "Threshold τ must be from 0 to 1 − G."],
      [Number.isFinite(settings.categoryWidth) && settings.categoryWidth >= 0.01 && settings.categoryWidth <= 1000, "Departure class width must be 0.01–1000 hours."],
    ];
    const failed = checks.find(([valid]) => !valid);
    if (failed) throw new Error(failed[1]);
    settings.probability = window.compileProbabilityExpression(settings.probabilityExpression);
    settings.effectiveCapacity = Math.min(1, settings.greenCapacity + settings.threshold);
    return settings;
  }

  const format = (number, digits = 2) => number.toFixed(digits);
  const label = (name) => name === "full-first-fit" ? "First Fit · full" : engine.LABELS[name];

  async function run(settings, onProgress, sequence) {
    const random = engine.seededRandom(settings.seed);
    const totals = Object.fromEntries(algorithms.map((name) => [name, { total: 0, binTime: 0, blackTime: 0, blackCost: 0, opened: 0, peakBins: 0 }]));
    let firstJobs = null;
    const firstOutcomes = {};
    for (let trial = 0; trial < settings.trials; trial += 1) {
      const jobs = engine.sampleTrial(settings, settings.probability, random);
      if (trial === 0) firstJobs = jobs;
      for (const name of algorithms) {
        const outcome = engine.simulate(jobs, name, settings.effectiveCapacity,
          settings.greenCapacity, settings.blackPrice, settings.categoryWidth, trial === 0);
        for (const key of Object.keys(totals[name])) totals[name][key] += outcome[key];
        if (trial === 0) firstOutcomes[name] = outcome;
      }
      if (sequence !== runSequence) throw new Error("A newer run has replaced this one.");
      onProgress(trial + 1, settings.trials);
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    for (const name of algorithms) for (const key of Object.keys(totals[name])) totals[name][key] /= settings.trials;
    return { settings, totals, firstJobs, firstOutcomes };
  }

  function renderRows(result) {
    const { totals } = result;
    const groups = [
      ["Non-clairvoyant · no duration information at placement", engine.NON_CLAIRVOYANT],
      ["Clairvoyant · reported departure known at placement", engine.CLAIRVOYANT],
      ["Reference · full capacity", ["full-first-fit"]],
    ];
    const maxCost = Math.max(...algorithms.map((name) => totals[name].total), 1e-12);
    $("cost-chart").innerHTML = groups.map(([title, names]) => `<div class="group-heading">${title}</div>` + names.map((name) => {
      const item = totals[name];
      return `<div class="cost-row${name === "full-first-fit" ? " reference-row" : ""}"><span class="cost-name">${label(name)}</span><div class="cost-track"><span class="cost-opening" style="width:${100 * item.binTime / maxCost}%"></span><span class="cost-black" style="width:${100 * item.blackCost / maxCost}%"></span></div><strong>${format(item.total)}</strong></div>`;
    }).join("")).join("");
    $("cost-chart").setAttribute("aria-label", algorithms.map((name) => `${label(name)}: mean cost ${format(totals[name].total)}`).join("; "));
    $("results-table").innerHTML = groups.map(([title, names]) => `<tr class="group-row"><th colspan="5">${title}</th></tr>` + names.map((name) => {
      const item = totals[name];
      return `<tr${name === "full-first-fit" ? ' class="reference-row"' : ""}><th scope="row">${label(name)}</th><td>${format(item.total)}</td><td>${format(item.binTime)}</td><td>${format(item.blackTime)}</td><td>${format(item.peakBins, 1)}</td></tr>`;
    }).join("")).join("");
  }

  function renderTimeline(result, name) {
    const outcome = result.firstOutcomes[name];
    const points = outcome.events;
    const width = 720, height = 185, left = 36, right = 708, top = 13, bottom = 151;
    const horizon = Math.max(outcome.horizon, 1);
    const peak = Math.max(outcome.peakBins, 1);
    const x = (time) => left + time / horizon * (right - left);
    const y = (bins) => bottom - bins / peak * (bottom - top);
    let path = `M${left} ${bottom}`;
    let current = 0;
    for (const point of points) {
      const px = x(point.time);
      path += `L${px.toFixed(2)} ${y(current).toFixed(2)}L${px.toFixed(2)} ${y(point.activeBins).toFixed(2)}`;
      current = point.activeBins;
    }
    const grid = [0, 0.5, 1].map((part) => {
      const yy = y(peak * part);
      return `<line x1="${left}" y1="${yy}" x2="${right}" y2="${yy}" stroke="#e3ebea"/><text x="${left - 7}" y="${yy + 4}" text-anchor="end">${Math.round(peak * part)}</text>`;
    }).join("");
    $("timeline-chart").innerHTML = `<svg viewBox="0 0 ${width} ${height}" aria-hidden="true"><g fill="#82999b" font-size="11" font-family="system-ui,sans-serif">${grid}<text x="${left}" y="177">0 h</text><text x="${right}" y="177" text-anchor="end">${format(outcome.horizon, 1)} h</text></g><path d="${path}" fill="none" stroke="#117890" stroke-width="2.6" stroke-linejoin="round"/></svg>`;
    $("timeline-chart").setAttribute("aria-label", `${label(name)} has a peak of ${outcome.peakBins} active bins and finishes at ${format(outcome.horizon, 1)} hours`);
    const binByJob = new Map(outcome.assignments.map((item) => [item.jobId, item.binId]));
    $("sample-table").innerHTML = result.firstJobs.slice(0, 100).map((job) => `<tr><th scope="row">${job.id}</th><td>${format(job.arrival)}</td><td>${format(job.actualSize)} → ${format(job.estimatedSize)} → <strong>${format(job.reportedSize)}</strong></td><td>${format(job.actualDuration)} → ${format(job.estimatedDuration)} → <strong>${format(job.reportedDuration)}</strong></td><td>${format(100 * job.hardProbability, 1)}%</td><td>${job.hard ? "Hard" : "Simple"}</td><td>${format(job.departure)}</td><td>${binByJob.get(job.id)}</td></tr>`).join("");
  }

  function render(result) {
    lastResult = result;
    const bestName = engine.ALGORITHMS.reduce((a, b) => result.totals[a].total <= result.totals[b].total ? a : b);
    const best = result.totals[bestName];
    $("best-cost").textContent = format(best.total);
    $("best-bin-time").textContent = format(best.binTime);
    $("best-black-time").textContent = format(best.blackTime);
    $("best-algorithm").textContent = `${label(bestName)} · mean per trial`;
    $("run-badge").textContent = `${result.settings.jobs} jobs × ${result.settings.trials} trials · seed ${result.settings.seed}`;
    renderRows(result);
    renderTimeline(result, $("inspect-algorithm").value);
  }

  function updateRegime() {
    const green = Number($("green-capacity").value);
    const threshold = Number($("packing-threshold").value);
    $("regime-note").textContent = Number.isFinite(green + threshold) && green >= 0 && green <= 1 && threshold >= 0 && green + threshold <= 1 + 1e-12
      ? `Effective fill limit G + τ = ${format(green + threshold)}. Larger reported jobs occupy a singleton bin; reported capacity never exceeds 1.`
      : "Choose 0 ≤ G ≤ 1 and 0 ≤ τ ≤ 1 − G.";
  }

  async function execute() {
    let settings;
    try { settings = readSettings(); }
    catch (error) { $("form-error").textContent = error.message; $("form-error").hidden = false; return; }
    $("form-error").hidden = true;
    const sequence = ++runSequence;
    const badgeBefore = $("run-badge").textContent;
    runButton.disabled = true;
    runButton.textContent = "Calculating…";
    $("run-badge").setAttribute("aria-busy", "true");
    try {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const result = await run(settings, (done, total) => { $("run-badge").textContent = `Calculating ${done} / ${total}`; }, sequence);
      render(result);
    } catch (error) {
      if (sequence === runSequence) {
        $("run-badge").textContent = badgeBefore;
        $("form-error").textContent = error.message || "The experiment failed.";
        $("form-error").hidden = false;
      }
    } finally {
      if (sequence === runSequence) {
        runButton.disabled = false;
        runButton.innerHTML = '<span aria-hidden="true">▶</span> Run dynamic experiment';
        $("run-badge").removeAttribute("aria-busy");
      }
    }
  }

  $("inspect-algorithm").innerHTML = algorithms.map((name) => `<option value="${name}">${label(name)}</option>`).join("");
  $("inspect-algorithm").addEventListener("change", () => { if (lastResult) renderTimeline(lastResult, $("inspect-algorithm").value); });
  $("probability-preset").addEventListener("change", () => { if (presets[$("probability-preset").value]) $("probability-expression").value = presets[$("probability-preset").value]; });
  $("probability-expression").addEventListener("input", () => { $("probability-preset").value = Object.entries(presets).find(([, expression]) => expression === $("probability-expression").value)?.[0] ?? "custom"; });
  ["green-capacity", "packing-threshold"].forEach((id) => $(id).addEventListener("input", updateRegime));
  form.addEventListener("submit", (event) => { event.preventDefault(); execute(); });
  updateRegime();
  execute();
})();
