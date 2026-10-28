(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const form = $("experiment-form");
  const runButton = form.querySelector("button[type=submit]");
  const errorTypes = new Set(["none", "normal", "uniform", "laplace", "triangular", "cauchy", "exponential", "two-point"]);
  const probabilityPresets = {
    logistic: "1/(1+exp(-12*(z-0.5)))",
    decreasing: "1-z",
    increasing: "z",
    constant: "0.5",
    step: "step(z-0.5)",
  };
  const algorithmDescriptions = {
    "first-fit": "First Fit checks open bins from oldest to newest and uses the first bin with room.",
    "best-fit": "Best Fit chooses the open bin that leaves the least unused space; ties go to the oldest bin.",
    "next-fit": "Next Fit tries only the current bin. If the job does not fit, it opens a new bin and never returns to earlier bins.",
    "random-fit": "Random Fit chooses uniformly among all open bins with room. If none fits, it opens a new bin.",
  };
  const algorithmLabels = { "first-fit": "First Fit", "best-fit": "Best Fit", "next-fit": "Next Fit", "random-fit": "Random Fit" };
  let runSequence = 0;

  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
  const format = (value, decimals = 1) => value.toFixed(decimals);
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const meanFeedback = (values) => values.reduce((average, value, index) => average + (value - average) / (index + 1), 0);
  const quantile = (sorted, p) => {
    const at = (sorted.length - 1) * p;
    const low = Math.floor(at);
    const fraction = at - low;
    return sorted[low] + (sorted[Math.min(low + 1, sorted.length - 1)] - sorted[low]) * fraction;
  };
  const sortedCopy = (values) => [...values].sort((a, b) => a - b);

  function firstFit(sizes, assignments) {
    let base = 1;
    while (base < sizes.length) base *= 2;
    const available = new Float64Array(base * 2);
    let opened = 0;
    for (const size of sizes) {
      let node;
      if (opened === 0 || available[1] + 1e-12 < size) {
        node = base + opened;
        opened += 1;
        available[node] = 1 - size;
      } else {
        node = 1;
        while (node < base) {
          node = available[node * 2] + 1e-12 >= size ? node * 2 : node * 2 + 1;
        }
        available[node] = Math.max(0, available[node] - size);
      }
      if (assignments && assignments.length < 100) assignments.push(node - base + 1);
      while (node > 1) {
        node = Math.floor(node / 2);
        available[node] = Math.max(available[node * 2], available[node * 2 + 1]);
      }
    }
    return opened;
  }

  function nextFit(sizes, assignments) {
    let opened = 0;
    let remaining = 0;
    for (const size of sizes) {
      if (opened === 0 || remaining + 1e-12 < size) {
        opened += 1;
        remaining = 1 - size;
      } else {
        remaining = Math.max(0, remaining - size);
      }
      if (assignments && assignments.length < 100) assignments.push(opened);
    }
    return opened;
  }

  function orderedFit(sizes, randomChoice, assignments) {
    // A treap keeps open bins ordered by free space, then by opening order.
    const compare = (left, right) => left.remaining - right.remaining || left.order - right.order;
    const updateCount = (node) => {
      node.count = 1 + (node.left?.count ?? 0) + (node.right?.count ?? 0);
      return node;
    };
    const merge = (left, right) => {
      if (!left) return right;
      if (!right) return left;
      if (left.priority < right.priority) {
        left.right = merge(left.right, right);
        return updateCount(left);
      }
      right.left = merge(left, right.left);
      return updateCount(right);
    };
    const insert = (root, node) => {
      if (!root) return node;
      if (compare(node, root) < 0) {
        root.left = insert(root.left, node);
        if (root.left.priority < root.priority) {
          const pivot = root.left;
          root.left = pivot.right;
          pivot.right = root;
          updateCount(root);
          return updateCount(pivot);
        }
      } else {
        root.right = insert(root.right, node);
        if (root.right.priority < root.priority) {
          const pivot = root.right;
          root.right = pivot.left;
          pivot.left = root;
          updateCount(root);
          return updateCount(pivot);
        }
      }
      return updateCount(root);
    };
    const remove = (root, node) => {
      if (root === node) return merge(root.left, root.right);
      if (compare(node, root) < 0) root.left = remove(root.left, node);
      else root.right = remove(root.right, node);
      return updateCount(root);
    };
    const priorityFor = (order) => {
      let value = (order + 1) ^ 0x9e3779b9;
      value ^= value << 13;
      value ^= value >>> 17;
      value ^= value << 5;
      return value >>> 0;
    };
    let root = null;
    let opened = 0;
    for (const size of sizes) {
      let current;
      let chosen = null;
      if (randomChoice) {
        const cutoff = size - 1e-12;
        let below = 0;
        current = root;
        while (current) {
          if (current.remaining < cutoff) {
            below += 1 + (current.left?.count ?? 0);
            current = current.right;
          } else {
            current = current.left;
          }
        }
        const eligible = (root?.count ?? 0) - below;
        if (eligible > 0) {
          let rank = below + Math.floor(Math.random() * eligible);
          current = root;
          while (current) {
            const leftCount = current.left?.count ?? 0;
            if (rank < leftCount) current = current.left;
            else if (rank === leftCount) { chosen = current; break; }
            else { rank -= leftCount + 1; current = current.right; }
          }
        }
      } else {
        current = root;
        while (current) {
          if (current.remaining + 1e-12 >= size) {
            chosen = current;
            current = current.left;
          } else {
            current = current.right;
          }
        }
      }
      if (chosen) {
        if (assignments && assignments.length < 100) assignments.push(chosen.order + 1);
        root = remove(root, chosen);
        chosen.remaining = Math.max(0, chosen.remaining - size);
        chosen.left = null;
        chosen.right = null;
        chosen.count = 1;
        root = insert(root, chosen);
      } else {
        if (assignments && assignments.length < 100) assignments.push(opened + 1);
        root = insert(root, { remaining: 1 - size, order: opened, priority: priorityFor(opened), left: null, right: null, count: 1 });
        opened += 1;
      }
    }
    return opened;
  }

  const packers = {
    "first-fit": firstFit,
    "best-fit": (sizes, assignments) => orderedFit(sizes, false, assignments),
    "next-fit": nextFit,
    "random-fit": (sizes, assignments) => orderedFit(sizes, true, assignments),
  };

  function noise(type, scale) {
    if (type === "none" || scale === 0) return 0;
    if (type === "uniform") return (2 * Math.random() - 1) * scale;
    if (type === "triangular") return (Math.random() - Math.random()) * scale;
    if (type === "cauchy") return scale * Math.tan(Math.PI * (Math.random() - 0.5));
    if (type === "exponential") return scale * (-Math.log(Math.max(Number.MIN_VALUE, 1 - Math.random())) - 1);
    if (type === "two-point") return Math.random() < 0.5 ? -scale : scale;
    if (type === "laplace") {
      const u = Math.random() - 0.5;
      return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
    }
    const u1 = Math.max(Number.MIN_VALUE, Math.random());
    const u2 = Math.random();
    return scale * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  function validate(raw) {
    const settings = {
      jobs: Number(raw.jobs),
      trials: Number(raw.trials),
      algorithm: String(raw.algorithm),
      probabilityExpression: String(raw.probabilityExpression),
      simpleThreshold: Number(raw.simpleThreshold),
      hardThreshold: Number(raw.hardThreshold),
      errorType: String(raw.errorType),
      errorScale: Number(raw.errorScale),
      feedbackEnabled: raw.feedbackEnabled ?? false,
      feedbackCoefficient: Number(raw.feedbackCoefficient ?? 1),
    };
    if (!settings.feedbackEnabled && (!Number.isFinite(settings.feedbackCoefficient) || settings.feedbackCoefficient < 0)) settings.feedbackCoefficient = 1;
    const checks = [
      [Number.isInteger(settings.jobs) && settings.jobs >= 500 && settings.jobs <= 5000, "Number of jobs must be an integer from 500 to 5000."],
      [Number.isInteger(settings.trials) && settings.trials >= 1 && settings.trials <= 300, "Number of trials must be an integer from 1 to 300."],
      [Object.hasOwn(packers, settings.algorithm), "Choose a supported placement algorithm."],
      [Number.isFinite(settings.simpleThreshold) && settings.simpleThreshold >= 0 && settings.simpleThreshold <= 1, "Simple upper bound must be between 0 and 1."],
      [Number.isFinite(settings.hardThreshold) && settings.hardThreshold >= 0 && settings.hardThreshold <= 1, "Hard lower bound must be between 0 and 1."],
      [errorTypes.has(settings.errorType), "Choose a supported error distribution."],
      [Number.isFinite(settings.errorScale) && settings.errorScale >= 0 && settings.errorScale <= 1, "Error scale must be between 0 and 1."],
      [typeof settings.feedbackEnabled === "boolean", "Choose whether feedback is on or off."],
      [!settings.feedbackEnabled || (Number.isFinite(settings.feedbackCoefficient) && settings.feedbackCoefficient >= 0 && Number.isFinite(settings.feedbackCoefficient * settings.jobs + settings.jobs)), "Feedback coefficient c must be a finite nonnegative number small enough to keep the objective finite."],
    ];
    const failed = checks.find(([valid]) => !valid);
    if (failed) throw new Error(failed[1]);
    window.compileProbabilityExpression(settings.probabilityExpression);
    return settings;
  }

  function settingsFromForm() {
    return validate({
      jobs: $("job-count").value,
      trials: $("trial-count").value,
      algorithm: $("packing-algorithm").value,
      probabilityExpression: $("probability-expression").value,
      simpleThreshold: $("simple-threshold").value,
      hardThreshold: $("hard-threshold").value,
      errorType: $("error-type").value,
      errorScale: $("error-scale").value,
      feedbackEnabled: $("feedback-enabled").checked,
      feedbackCoefficient: $("feedback-coefficient").value,
    });
  }

  async function runSimulation(settings, onProgress, runId) {
    const probability = window.compileProbabilityExpression(settings.probabilityExpression);
    const trueCounts = [];
    const reportedCounts = [];
    const feedbackTotals = [];
    const feedbackJobCounts = [];
    let firstRows = [];
    for (let trial = 0; trial < settings.trials; trial += 1) {
      const actual = [];
      const reported = [];
      const rows = [];
      let feedbackTotal = 0;
      let feedbackJobCount = 0;
      for (let job = 0; job < settings.jobs; job += 1) {
        const size = Math.random();
        const perceived = clamp(size + noise(settings.errorType, settings.errorScale), 0, 1);
        const hardProbability = probability(perceived);
        const hard = Math.random() < hardProbability;
        const report = hard ? Math.max(settings.hardThreshold, perceived) : Math.min(settings.simpleThreshold, perceived);
        // X_j in the feedback formula is perceived z, before min/max reporting.
        const feedback = settings.feedbackEnabled && !hard ? Math.max(perceived - settings.simpleThreshold, 0) * settings.feedbackCoefficient : 0;
        feedbackTotal += feedback;
        if (feedback > 0) feedbackJobCount += 1;
        actual.push(size);
        reported.push(report);
        if (trial === 0 && rows.length < 100) rows.push({ id: job + 1, actual: size, perceived, hardProbability, hard, reported: report, simpleIndicator: Number(!hard), feedback });
      }
      const trueAssignments = trial === 0 ? [] : null;
      const reportedAssignments = trial === 0 ? [] : null;
      trueCounts.push(packers[settings.algorithm](actual, trueAssignments));
      reportedCounts.push(packers[settings.algorithm](reported, reportedAssignments));
      feedbackTotals.push(feedbackTotal);
      feedbackJobCounts.push(feedbackJobCount);
      if (trial === 0) firstRows = rows.map((row, index) => ({ ...row, trueBin: trueAssignments[index], reportedBin: reportedAssignments[index] }));
      if ((trial + 1) % 5 === 0 || trial + 1 === settings.trials) {
        if (runId !== runSequence) throw new Error("A newer experiment has replaced this run.");
        onProgress(trial + 1, settings.trials);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }
    const differences = reportedCounts.map((count, index) => count - trueCounts[index]);
    const reportedObjectives = reportedCounts.map((count, index) => count + feedbackTotals[index]);
    const objectiveDifferences = reportedObjectives.map((objective, index) => objective - trueCounts[index]);
    const trueMean = mean(trueCounts);
    const reportedMean = mean(reportedCounts);
    const differenceMean = mean(differences);
    const feedbackMean = meanFeedback(feedbackTotals);
    return { settings, trueCounts, reportedCounts, differences, firstRows, feedbackTotals, feedbackJobCounts, reportedObjectives, objectiveDifferences, trueMean, reportedMean, differenceMean, feedbackMean, feedbackJobMean: mean(feedbackJobCounts), objectiveMean: reportedMean + feedbackMean, objectiveDifferenceMean: differenceMean + feedbackMean };
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

  function drawMainChart(result) {
    const series = [
      { label: "Model 1", values: result.trueCounts, color: "#117890", mean: result.trueMean },
      { label: "Model 2", values: result.reportedCounts, color: "#d79a2d", mean: result.reportedMean },
    ];
    const minValue = Math.min(...result.trueCounts, ...result.reportedCounts);
    const maxValue = Math.max(...result.trueCounts, ...result.reportedCounts);
    const axisMin = Math.max(0, Math.floor((minValue - Math.max(2, (maxValue - minValue) * 0.15)) / 5) * 5);
    const axisMax = Math.max(axisMin + 5, Math.ceil((maxValue + Math.max(2, (maxValue - minValue) * 0.15)) / 5) * 5);
    const W = 760, H = 220, L = 108, R = 42, T = 13, B = 181;
    const x = (value) => L + (value - axisMin) / (axisMax - axisMin) * (W - L - R);
    const ticks = 5;
    let svg = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">`;
    for (let i = 0; i <= ticks; i += 1) {
      const value = axisMin + (axisMax - axisMin) * i / ticks;
      const px = x(value);
      svg += `<line x1="${px}" y1="${T}" x2="${px}" y2="${B}" stroke="#e5ecea"/><text x="${px}" y="211" text-anchor="middle" fill="#84989c" font-size="12" font-family="system-ui,sans-serif">${format(value, value % 1 ? 1 : 0)}</text>`;
    }
    series.forEach((item, index) => {
      const y = index === 0 ? 62 : 135;
      const sorted = sortedCopy(item.values);
      const low = quantile(sorted, 0.05), high = quantile(sorted, 0.95);
      svg += `<rect x="${L}" y="${y - 28}" width="${W - L - R}" height="56" rx="5" fill="${index === 0 ? "#f2f8f9" : "#fffbf2"}"/><text x="8" y="${y + 4}" fill="#3c5860" font-size="15" font-weight="700" font-family="system-ui,sans-serif">${item.label}</text>`;
      if (item.values.length > 1) item.values.forEach((value, i) => {
        const jitter = ((i * 37) % 19) - 9;
        svg += `<circle cx="${x(value)}" cy="${y + jitter}" r="2.6" fill="${item.color}" opacity=".20"/>`;
      });
      svg += `<line x1="${x(low)}" y1="${y}" x2="${x(high)}" y2="${y}" stroke="${item.color}" stroke-width="5" stroke-linecap="round" opacity=".8"/><line x1="${x(low)}" y1="${y - 9}" x2="${x(low)}" y2="${y + 9}" stroke="${item.color}" stroke-width="2"/><line x1="${x(high)}" y1="${y - 9}" x2="${x(high)}" y2="${y + 9}" stroke="${item.color}" stroke-width="2"/><circle cx="${x(item.mean)}" cy="${y}" r="8" fill="${item.color}" stroke="white" stroke-width="3"/>`;
      const textX = x(item.mean) > W - 82 ? x(item.mean) - 14 : x(item.mean) + 14;
      svg += `<text x="${textX}" y="${y - 15}" text-anchor="${x(item.mean) > W - 82 ? "end" : "start"}" fill="${item.color}" font-size="14" font-weight="800" font-family="system-ui,sans-serif">${format(item.mean)}</text>`;
    });
    svg += `</svg>`;
    $("main-chart").innerHTML = svg;
    $("main-chart").setAttribute("aria-label", `Model 1 mean ${format(result.trueMean)} bins; Model 2 mean ${format(result.reportedMean)} bins. Lines show each model’s 5th–95th percentile range.`);
  }

  function drawDifferenceChart(result) {
    const values = result.differences;
    const rawMin = Math.min(...values, 0), rawMax = Math.max(...values, 0);
    const min = Math.floor(rawMin - 1), max = Math.ceil(rawMax + 1);
    const width = 560, height = 150, left = 32, right = 20, top = 12, bottom = 123;
    const bins = Math.min(21, Math.max(7, max - min + 1));
    const counts = Array(bins).fill(0);
    values.forEach((value) => {
      const index = Math.min(bins - 1, Math.floor((value - min) / (max - min) * bins));
      counts[index] += 1;
    });
    const peak = Math.max(...counts, 1);
    const plotWidth = width - left - right;
    const zeroX = left + (0 - min) / (max - min) * plotWidth;
    let svg = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true"><line x1="${left}" y1="${bottom}" x2="${width - right}" y2="${bottom}" stroke="#bacbc8"/><line x1="${zeroX}" y1="${top}" x2="${zeroX}" y2="${bottom}" stroke="#98aeb0" stroke-width="2" stroke-dasharray="4 4"/>`;
    counts.forEach((count, i) => {
      const step = plotWidth / bins;
      const barWidth = Math.max(2, step - 3);
      const barHeight = count / peak * 91;
      const x = left + i * step + (step - barWidth) / 2;
      svg += `<rect x="${x}" y="${bottom - barHeight}" width="${barWidth}" height="${barHeight}" rx="2" fill="${x + step / 2 < zeroX ? "#117890" : "#d79a2d"}" opacity=".82"/>`;
    });
    svg += `<g fill="#82969a" font-size="12" font-family="system-ui,sans-serif"><text x="${left}" y="145" text-anchor="middle">${min}</text><text x="${zeroX}" y="145" text-anchor="middle">0</text><text x="${width - right}" y="145" text-anchor="middle">${max}</text></g></svg>`;
    $("difference-chart").innerHTML = svg;
    $("difference-chart").setAttribute("aria-label", `Across ${values.length} trials, Model 2 minus Model 1 ranges from ${Math.min(...values)} to ${Math.max(...values)} bins, with a mean of ${format(result.differenceMean)}.`);
  }

  function renderFeedback(result) {
    const signed = (value) => `${value > 0 ? "+" : ""}${format(value, 2)}`;
    $("feedback-status").textContent = result.settings.feedbackEnabled ? `Feedback on · c = ${result.settings.feedbackCoefficient}` : "Feedback off";
    $("feedback-mean").textContent = format(result.feedbackMean, 2);
    $("objective-mean").textContent = format(result.objectiveMean, 2);
    $("objective-difference").textContent = signed(result.objectiveDifferenceMean);
    $("objective-difference-note").textContent = result.objectiveDifferenceMean > 0 ? "Model 2 has a higher mean objective" : result.objectiveDifferenceMean < 0 ? "Model 2 has a lower mean objective" : "Both models have the same mean objective";
    const maximum = Math.max(result.trueMean, result.objectiveMean, 1);
    $("objective-comparison").innerHTML = `<div class="cost-row"><span class="cost-name">Model 1 · J₁</span><div class="cost-track"><span class="objective-true" style="width:${result.trueMean / maximum * 100}%"></span></div><strong>${format(result.trueMean, 2)}</strong></div><div class="cost-row"><span class="cost-name">Model 2 · J₂</span><div class="cost-track"><span class="objective-reported" style="width:${result.reportedMean / maximum * 100}%"></span><span class="objective-feedback" style="width:${result.feedbackMean / maximum * 100}%"></span></div><strong>${format(result.objectiveMean, 2)}</strong></div>`;
    $("objective-comparison").setAttribute("aria-label", `Mean objective: Model 1 ${format(result.trueMean, 2)}; Model 2 ${format(result.objectiveMean, 2)}, comprising ${format(result.reportedMean, 2)} bins and ${format(result.feedbackMean, 2)} feedback.`);
    $("feedback-summary").textContent = result.settings.feedbackEnabled ? `Perceived-size feedback with s = ${result.settings.simpleThreshold}, c = ${result.settings.feedbackCoefficient}. Mean jobs with αⱼ > 0: ${format(result.feedbackJobMean)} of ${result.settings.jobs} per trial. Totals include every job in each trial.` : "Feedback is off: every αⱼ = 0, so each model’s objective equals its bin count.";
  }

  function render(result) {
    $("true-mean").textContent = format(result.trueMean);
    $("reported-mean").textContent = format(result.reportedMean);
    $("difference-mean").textContent = `${result.differenceMean > 0 ? "+" : ""}${format(result.differenceMean)}`;
    $("run-badge").textContent = `${algorithmLabels[result.settings.algorithm]} · ${result.settings.jobs} jobs × ${result.settings.trials} trials`;
    $("difference-note").textContent = result.differenceMean > 0 ? "Reported-size model uses more bins on average" : result.differenceMean < 0 ? "Reported-size model uses fewer bins on average" : "Both models use the same mean number of bins";
    drawMainChart(result);
    drawDifferenceChart(result);
    renderFeedback(result);
    $("sample-table").innerHTML = result.firstRows.map((row) => `<tr><th scope="row">${row.id}</th><td>${format(row.actual, 3)}</td><td>${format(row.perceived, 3)}</td><td>${format(100 * row.hardProbability, 1)}%</td><td>${row.hard ? "Hard" : "Simple"}</td><td>${format(row.reported, 3)}</td><td>${row.simpleIndicator}</td><td>${format(row.feedback, 4)}</td><td>${row.trueBin}</td><td>${row.reportedBin}</td></tr>`).join("");
  }

  function showError(message) {
    $("form-error").textContent = message;
    $("form-error").hidden = !message;
  }

  async function executeSettings(settings) {
    const currentRun = ++runSequence;
    const priorBadge = $("run-badge").textContent;
    showError("");
    runButton.disabled = true;
    runButton.textContent = "Calculating…";
    $("run-badge").setAttribute("aria-busy", "true");
    try {
      const result = await runSimulation(settings, (done, total) => {
        $("run-badge").textContent = `Calculating ${done} / ${total}`;
      }, currentRun);
      if (currentRun !== runSequence) throw new Error("A newer experiment has replaced this run.");
      render(result);
      return result;
    } catch (error) {
      if (currentRun === runSequence) $("run-badge").textContent = priorBadge;
      throw error;
    } finally {
      if (currentRun === runSequence) {
        runButton.disabled = false;
        runButton.innerHTML = '<span aria-hidden="true">▶</span> Run random experiment';
        $("run-badge").removeAttribute("aria-busy");
      }
    }
  }

  async function executeFromForm() {
    try { await executeSettings(settingsFromForm()); }
    catch (error) { showError(error.message || "The experiment failed. Please try again."); }
  }

  function updateErrorDescription() {
    const type = $("error-type").value;
    const details = {
      none: ["", "No judgment error is added. "],
      normal: ["Standard deviation σ", "Normal distribution: ε ~ N(0, σ²). "],
      uniform: ["Half-width h", "Uniform distribution: ε ~ Uniform(-h, h). "],
      laplace: ["Scale b", "Laplace distribution: centered at 0 with scale b. "],
      triangular: ["Half-width h", "Symmetric triangular distribution: ε lies in [-h, h] and is concentrated near 0. "],
      cauchy: ["Scale γ", "Cauchy distribution: centered at 0 with heavy tails. "],
      exponential: ["Scale b", "Centered exponential: ε = b(X − 1), X ~ Exp(1); right-skewed. "],
      "two-point": ["Magnitude d", "Two-point distribution: ε is equally likely to be -d or +d. "],
    };
    $("error-scale-field").hidden = type === "none";
    $("error-scale-label").textContent = details[type][0];
    $("error-description").textContent = `${details[type][1]}Clip a + ε to [0, 1] to obtain z before selecting a mode.`;
  }

  function updateAlgorithmDescription() {
    const description = algorithmDescriptions[$("packing-algorithm").value];
    $("algorithm-description").textContent = description;
    $("selected-algorithm-rule").textContent = `${description} Both models use this same placement rule.`;
  }

  function updateFeedbackControls() {
    $("feedback-coefficient").disabled = !$("feedback-enabled").checked;
  }

  form.addEventListener("submit", (event) => { event.preventDefault(); executeFromForm(); });
  $("advanced-toggle").addEventListener("click", () => {
    const expanded = $("advanced-toggle").getAttribute("aria-expanded") !== "true";
    $("advanced-toggle").setAttribute("aria-expanded", String(expanded));
    $("advanced-toggle").textContent = expanded ? "Fewer settings" : "More settings";
    document.querySelector(".controls").classList.toggle("expanded", expanded);
  });
  $("probability-preset").addEventListener("change", () => {
    const preset = probabilityPresets[$("probability-preset").value];
    if (preset) $("probability-expression").value = preset;
    drawProbabilityCurve();
  });
  $("probability-expression").addEventListener("input", () => {
    const currentPreset = Object.entries(probabilityPresets).find(([, expression]) => expression === $("probability-expression").value)?.[0] ?? "custom";
    $("probability-preset").value = currentPreset;
    drawProbabilityCurve();
  });
  $("error-type").addEventListener("change", updateErrorDescription);
  $("packing-algorithm").addEventListener("change", updateAlgorithmDescription);
  $("feedback-enabled").addEventListener("change", updateFeedbackControls);
  drawProbabilityCurve();
  updateErrorDescription();
  updateAlgorithmDescription();
  updateFeedbackControls();
  executeFromForm();

  // Browser agents can run the same visible experiment without a separate backend.
  if (document.modelContext?.registerTool) {
    const schema = {
      type: "object",
      properties: {
        jobs: { type: "integer", minimum: 500, maximum: 5000 },
        trials: { type: "integer", minimum: 1, maximum: 300 },
        algorithm: { type: "string", enum: Object.keys(packers) },
        probabilityExpression: { type: "string", minLength: 1, maxLength: 180 },
        simpleThreshold: { type: "number", minimum: 0, maximum: 1 },
        hardThreshold: { type: "number", minimum: 0, maximum: 1 },
        errorType: { type: "string", enum: [...errorTypes] },
        errorScale: { type: "number", minimum: 0, maximum: 1 },
        feedbackEnabled: { type: "boolean", default: false },
        feedbackCoefficient: { type: "number", minimum: 0, default: 1 },
      },
      required: ["jobs", "trials", "algorithm", "probabilityExpression", "simpleThreshold", "hardThreshold", "errorType", "errorScale"],
      additionalProperties: false,
    };
    try {
      Promise.resolve(document.modelContext.registerTool({
        name: "run_bin_packing_experiment",
        title: "Run bin packing experiment",
        description: "Run paired randomized bin packing trials and update bin-count and optional perceived-size feedback objectives.",
        inputSchema: schema,
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        async execute(input) {
          const settings = validate(input);
          const mapping = { jobs: "job-count", trials: "trial-count", algorithm: "packing-algorithm", probabilityExpression: "probability-expression", simpleThreshold: "simple-threshold", hardThreshold: "hard-threshold", errorType: "error-type", errorScale: "error-scale", feedbackCoefficient: "feedback-coefficient" };
          Object.entries(mapping).forEach(([key, id]) => { $(id).value = settings[key]; });
          $("feedback-enabled").checked = settings.feedbackEnabled;
          $("probability-expression").dispatchEvent(new Event("input"));
          updateErrorDescription();
          updateAlgorithmDescription();
          updateFeedbackControls();
          drawProbabilityCurve();
          const result = await executeSettings(settings);
          return { trueMean: result.trueMean, reportedMean: result.reportedMean, differenceMean: result.differenceMean, feedbackMean: result.feedbackMean, feedbackJobMean: result.feedbackJobMean, objectiveMean: result.objectiveMean, objectiveDifferenceMean: result.objectiveDifferenceMean, feedbackEnabled: settings.feedbackEnabled, feedbackCoefficient: settings.feedbackCoefficient, trials: settings.trials };
        },
      })).catch(() => {});
    } catch (_) { /* The normal page works without WebMCP. */ }
  }
})();
