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
    "two-layer-ff": "双层 FF first places threshold Simple (r = s) into an eligible existing ordinary Hard bin, in opening order; only then reserves it if needed. Threshold Hard (r = h) first matches a reserved Simple, otherwise uses ordinary First Fit. Other jobs and Simple overflow use the ordinary pool.",
    "two-layer-bf": "双层 BF first places threshold Simple (r = s) into an eligible existing ordinary Hard bin, by best fit; only then reserves it if needed. Threshold Hard (r = h) first matches a reserved Simple, otherwise uses ordinary Best Fit. Other jobs and Simple overflow use the ordinary pool.",
  };
  const algorithmLabels = { "first-fit": "First Fit", "best-fit": "Best Fit", "next-fit": "Next Fit", "random-fit": "Random Fit", "two-layer-ff": "双层 FF", "two-layer-bf": "双层 BF" };
  const isTwoLayer = (algorithm) => algorithm === "two-layer-ff" || algorithm === "two-layer-bf";
  const baselineAlgorithm = (algorithm) => algorithm === "two-layer-ff" ? "first-fit" : algorithm === "two-layer-bf" ? "best-fit" : algorithm;
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

  function firstFit(sizes, assignments, random, capacity = sizes.length) {
    let base = 1;
    while (base < capacity) base *= 2;
    const available = new Float64Array(base * 2);
    let opened = 0;
    for (const item of sizes) {
      const size = typeof item === "number" ? item : item.size;
      const forcedBin = typeof item === "number" ? null : item.bin;
      let node;
      if (forcedBin != null) {
        if (!Number.isInteger(forcedBin) || forcedBin < 1 || forcedBin > opened || available[base + forcedBin - 1] + 1e-12 < size) throw new Error("Directed First Fit placement needs a fitting existing bin.");
        node = base + forcedBin - 1;
        available[node] = Math.max(0, available[node] - size);
      } else if (opened === 0 || available[1] + 1e-12 < size) {
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

  function orderedFit(sizes, randomChoice, assignments, random = Math.random) {
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
    const nodes = [];
    for (const item of sizes) {
      const size = typeof item === "number" ? item : item.size;
      const forcedBin = typeof item === "number" ? null : item.bin;
      let current;
      let chosen = null;
      if (forcedBin != null) {
        chosen = nodes[forcedBin - 1];
        if (!Number.isInteger(forcedBin) || !chosen || chosen.remaining + 1e-12 < size) throw new Error("Directed Best Fit placement needs a fitting existing bin.");
      } else if (randomChoice) {
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
          let rank = below + Math.floor(random() * eligible);
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
        const node = { remaining: 1 - size, order: opened, priority: priorityFor(opened), left: null, right: null, count: 1 };
        nodes.push(node);
        root = insert(root, node);
        opened += 1;
      }
    }
    return opened;
  }

  function twoLayerFit(jobs, assignments, capacity, settings, ordinaryFit, stats = {}, preferBestFit = false) {
    const limit = settings.reservationLimit ?? 10;
    let opened = 0, waiting = 0, currentJob, ordinaryRoute;
    const pendingSimple = [];
    let simpleHead = 0;
    const ordinaryBins = new Map();
    const hardCandidates = [];
    const compareCandidates = (a, b) => (preferBestFit ? a.remaining - b.remaining : 0) || a.localBin - b.localBin;
    const pushCandidate = (entry) => {
      let at = hardCandidates.length;
      hardCandidates.push(entry);
      while (at > 0) {
        const parent = Math.floor((at - 1) / 2);
        if (compareCandidates(hardCandidates[parent], entry) <= 0) break;
        hardCandidates[at] = hardCandidates[parent]; at = parent;
      }
      hardCandidates[at] = entry;
    };
    const popCandidate = () => {
      const last = hardCandidates.pop();
      if (!hardCandidates.length) return;
      let at = 0;
      while (at * 2 + 1 < hardCandidates.length) {
        let child = at * 2 + 1;
        if (child + 1 < hardCandidates.length && compareCandidates(hardCandidates[child + 1], hardCandidates[child]) < 0) child += 1;
        if (compareCandidates(last, hardCandidates[child]) <= 0) break;
        hardCandidates[at] = hardCandidates[child]; at = child;
      }
      hardCandidates[at] = last;
    };
    const availableHardBin = () => {
      while (hardCandidates.length) {
        const candidate = hardCandidates[0], bin = ordinaryBins.get(candidate.localBin);
        if (candidate.remaining === bin.remaining && bin.remaining + 1e-12 >= settings.simpleThreshold) return candidate.localBin;
        popCandidate();
      }
      return null;
    };
    Object.assign(stats, { pairs: 0, ordinaryHardFills: 0, unmatched: 0, overflow: 0, ordinaryBins: 0, thresholdSimple: 0, thresholdHard: 0, peakReserved: 0 });
    const record = (job, bin, layer) => {
      if (assignments && assignments.length < 100) assignments.push(bin);
      if (job.row) job.row.placementLayer = layer;
    };
    // The proxy translates local ordinary-pool IDs into global opening-order IDs.
    // Its length stays zero so the base packer reports every placement, not just 100.
    const ordinaryAssignments = { length: 0, push(localBin) {
      if (!ordinaryBins.has(localBin)) ordinaryBins.set(localBin, { globalBin: ++opened, remaining: 1, hard: false });
      const bin = ordinaryBins.get(localBin), wasHard = bin.hard, beforeRemaining = bin.remaining;
      bin.remaining = Math.max(0, bin.remaining - currentJob.size);
      bin.hard ||= currentJob.hard;
      // A bin acquires Hard at most once (h > 1/2). Any later load only
      // decreases capacity; stale heap entries are discarded when queried.
      if (bin.hard && bin.remaining + 1e-12 >= settings.simpleThreshold && (!wasHard || beforeRemaining !== bin.remaining)) pushCandidate({ localBin, remaining: bin.remaining });
      record(currentJob, bin.globalBin, ordinaryRoute);
    } };
    function* ordinaryJobs() {
      for (const job of jobs) {
        // Exact equality is intentional: nearby, unstandardized sizes are not atoms.
        const side = !job.hard && job.size === settings.simpleThreshold ? "simple"
          : job.hard && job.size === settings.hardThreshold ? "hard" : null;
        if (side) {
          stats[side === "simple" ? "thresholdSimple" : "thresholdHard"] += 1;
          if (side === "simple" && limit > 0) {
            const existingHard = availableHardBin();
            if (existingHard !== null) {
              currentJob = job; ordinaryRoute = "Ordinary Hard bin · filled before reservation";
              stats.ordinaryHardFills += 1;
              yield { size: job.size, bin: existingHard };
              continue;
            }
          }
          if (side === "hard" && waiting > 0) {
            const bin = pendingSimple[simpleHead++];
            waiting -= 1; stats.pairs += 1;
            record(job, bin, "Threshold pair · completed");
            continue;
          }
          if (side === "simple" && waiting < limit) {
            const bin = ++opened;
            pendingSimple.push(bin); waiting += 1;
            stats.peakReserved = Math.max(stats.peakReserved, waiting);
            record(job, bin, "Threshold Simple reservation · opened");
            continue;
          }
          if (side === "simple") stats.overflow += 1;
        }
        currentJob = job;
        ordinaryRoute = "Ordinary pool";
        yield job.size; // Base FF/BF places this job before the next submission.
      }
    }
    stats.ordinaryBins = ordinaryFit(ordinaryJobs(), ordinaryAssignments, undefined, capacity);
    stats.unmatched = waiting;
    return opened;
  }

  const packers = {
    "first-fit": firstFit,
    "best-fit": (sizes, assignments) => orderedFit(sizes, false, assignments),
    "next-fit": nextFit,
    "random-fit": (sizes, assignments, random) => orderedFit(sizes, true, assignments, random),
    "two-layer-ff": (jobs, assignments, random, capacity, settings, stats) => twoLayerFit(jobs, assignments, capacity, settings, firstFit, stats),
    "two-layer-bf": (jobs, assignments, random, capacity, settings, stats) => twoLayerFit(jobs, assignments, capacity, settings, (sizes, bins) => orderedFit(sizes, false, bins), stats, true),
  };

  function noise(type, scale, random = Math.random) {
    if (type === "none" || scale === 0) return 0;
    if (type === "uniform") return (2 * random() - 1) * scale;
    if (type === "triangular") return (random() - random()) * scale;
    if (type === "cauchy") return scale * Math.tan(Math.PI * (random() - 0.5));
    if (type === "exponential") return scale * (-Math.log(Math.max(Number.MIN_VALUE, 1 - random())) - 1);
    if (type === "two-point") return random() < 0.5 ? -scale : scale;
    if (type === "laplace") {
      const u = random() - 0.5;
      return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
    }
    const u1 = Math.max(Number.MIN_VALUE, random());
    const u2 = random();
    return scale * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  function validate(raw) {
    const settings = {
      ...window.StaticBehavior.settings(raw),
      jobs: Number(raw.jobs),
      trials: Number(raw.trials),
      algorithm: String(raw.algorithm),
      reservationLimit: Number(raw.reservationLimit ?? 10),
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
      [!isTwoLayer(settings.algorithm) || (Number.isInteger(settings.reservationLimit) && settings.reservationLimit >= 0 && settings.reservationLimit <= 5000), "Reservation limit K must be an integer from 0 to 5000."],
      [!isTwoLayer(settings.algorithm) || (settings.simpleThreshold > 0 && settings.simpleThreshold < 0.5 && settings.hardThreshold > 0.5 && settings.hardThreshold < 1 && Math.abs(settings.simpleThreshold + settings.hardThreshold - 1) <= 1e-12), "双层 FF/BF requires 0 < s < 0.5 and h = 1 − s. Use the complementary-bounds button or adjust Reported size."],
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
      ...behaviorFromForm(),
      jobs: $("job-count").value,
      trials: $("trial-count").value,
      algorithm: $("packing-algorithm").value,
      reservationLimit: $("reservation-limit").value,
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
    const behavior = window.StaticBehavior;
    settings = { ...behavior.defaults, ...settings };
    const probability = window.compileProbabilityExpression(settings.probabilityExpression);
    const trueCounts = [], reportedCounts = [], feedbackTotals = [], feedbackJobCounts = [];
    const finalRates = [], rounds = [], reservationTrials = [], reportedBaselineCounts = [];
    const userTotals = { jobs: 0, hard: 0, observedSimple: 0, failures: 0 };
    let firstRows = [], firstUser = null, firstSizes = [], firstReportedSizes = [];
    for (let trial = 0; trial < settings.trials; trial += 1) {
      const seeded = String(settings.seed) !== "";
      const baseSeed = (Number(settings.seed) + Math.imul(trial + 1, 0x9e3779b9)) >>> 0;
      const sampleRandom = seeded ? behavior.rng(baseSeed) : Math.random;
      const modeRandom = seeded ? behavior.rng(baseSeed ^ 0xa5a5a5a5) : Math.random;
      const trueRandom = seeded ? behavior.rng(baseSeed ^ 0xb6b6b6b6) : Math.random;
      const reportRandom = seeded ? behavior.rng(baseSeed ^ 0xc7c7c7c7) : Math.random;
      // Placement randomness cannot change exogenous jobs, perception or mode draws.
      const inputs = Array.from({ length: settings.jobs }, () => {
        const actual = behavior.sampleSize(settings, sampleRandom);
        const perceived = clamp(actual + noise(settings.errorType, settings.errorScale, sampleRandom), 0, 1);
        return { actual, perceived, draw: modeRandom(), baseProbability: probability(perceived) };
      });
      const actual = inputs.map(job => job.actual), reported = [], rows = [];
      const user = behavior.createUser(settings);
      let feedbackTotal = 0, feedbackJobCount = 0;
      const trueAssignments = trial === 0 ? [] : null;
      const reportedAssignments = trial === 0 ? [] : null;
      function* submissions() {
        for (let job = 0; job < settings.jobs; job += 1) {
          const input = inputs[job], perceived = input.perceived;
          const decision = behavior.chooseMode(user, input.baseProbability, settings.feedbackEnabled, input.draw);
          const hard = decision.hard;
          // The merchant standardizes only AFTER the user's mode draw.
          const report = hard ? Math.max(settings.hardThreshold, perceived) : Math.min(settings.simpleThreshold, perceived);
          const shortfall = Math.max(perceived - report, 0);
          const qualityFailed = settings.feedbackEnabled && shortfall > 0;
          const feedback = settings.feedbackEnabled ? shortfall * settings.feedbackCoefficient : 0;
          feedbackTotal += feedback; feedbackJobCount += Number(feedback > 0);
          reported.push(report);
          const row = { id: job + 1, userId: 1, submission: job + 1, actual: input.actual, perceived,
            baseProbability: decision.baseProbability, hardProbability: decision.hardProbability, draw: decision.draw,
            lambda: user.lambda, hard, reported: report, simpleIndicator: Number(!hard), feedback,
            qualityFailed, expectedBefore: decision.expectedBefore,
            observationsBefore: decision.observationsBefore, failuresBefore: decision.failuresBefore };
          if (trial === 0 && rows.length < 100) rows.push(row);
          yield isTwoLayer(settings.algorithm) ? { size: report, hard, row } : report; // Receive the quality outcome only after placement completes.
          behavior.receiveFeedback(user, { hard, feedback, qualityFailed }, settings.feedbackEnabled);
          row.expectedAfter = user.q;
          row.observedSimple = user.observedSimple;
          row.failures = user.failures;
          if (!rounds[job]) rounds[job] = { jobs: 0, hard: 0, baseProbability: 0, hardProbability: 0, qBefore: 0 };
          const bucket = rounds[job];
          bucket.jobs += 1; bucket.hard += Number(hard);
          bucket.baseProbability += decision.baseProbability; bucket.hardProbability += decision.hardProbability;
          bucket.qBefore += decision.expectedBefore;
        }
      }
      const reservationStats = {};
      const reportedCount = packers[settings.algorithm](submissions(), reportedAssignments, reportRandom, settings.jobs, settings, reservationStats);
      const trueCount = packers[baselineAlgorithm(settings.algorithm)](actual, trueAssignments, trueRandom);
      if (isTwoLayer(settings.algorithm)) {
        reservationTrials.push(reservationStats);
        reportedBaselineCounts.push(packers[baselineAlgorithm(settings.algorithm)](reported));
      }
      trueCounts.push(trueCount); reportedCounts.push(reportedCount);
      feedbackTotals.push(feedbackTotal); feedbackJobCounts.push(feedbackJobCount);
      finalRates.push(user.q);
      userTotals.jobs += user.submissions; userTotals.hard += user.hardCount;
      userTotals.observedSimple += user.observedSimple; userTotals.failures += user.failures;
      if (trial === 0) {
        firstRows = rows.map((row, index) => ({ ...row, trueBin: trueAssignments[index], reportedBin: reportedAssignments[index] }));
        firstUser = { ...user }; firstSizes = actual; firstReportedSizes = reported;
      }
      if ((trial + 1) % 5 === 0 || trial + 1 === settings.trials) {
        if (runId !== runSequence) throw new Error("A newer experiment has replaced this run.");
        onProgress(trial + 1, settings.trials);
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }
    const differences = reportedCounts.map((count, index) => count - trueCounts[index]);
    const reportedObjectives = reportedCounts.map((count, index) => count + feedbackTotals[index]);
    const objectiveDifferences = reportedObjectives.map((objective, index) => objective - trueCounts[index]);
    const trueMean = mean(trueCounts), reportedMean = mean(reportedCounts), differenceMean = mean(differences), feedbackMean = meanFeedback(feedbackTotals);
    const reservationMeans = reservationTrials.length ? Object.fromEntries(Object.keys(reservationTrials[0]).map(key => [key, mean(reservationTrials.map(stats => stats[key]))])) : null;
    return { settings, trueCounts, reportedCounts, differences, firstRows, firstUser, firstSizes, firstReportedSizes, reservationTrials, reservationMeans,
      reportedBaselineCounts, reportedBaselineMean: reportedBaselineCounts.length ? mean(reportedBaselineCounts) : null,
      userTotals, rounds, finalRates, finalRateMean: mean(finalRates), hardShare: userTotals.hard / userTotals.jobs,
      feedbackTotals, feedbackJobCounts, reportedObjectives, objectiveDifferences,
      trueMean, reportedMean, differenceMean, feedbackMean, feedbackJobMean: mean(feedbackJobCounts),
      objectiveMean: reportedMean + feedbackMean, objectiveDifferenceMean: differenceMean + feedbackMean };
  }

  const behaviorFields = {
    sizeDistribution: "size-distribution", sizeMin: "size-min", sizeMax: "size-max", sizeMean: "size-mean", sizeStd: "size-std",
    betaAlpha: "beta-alpha", betaBeta: "beta-beta", sizeRate: "size-rate", mixtureWeight: "mixture-weight",
    mixtureLow: "mixture-low", mixtureHigh: "mixture-high", mixtureStd: "mixture-std", seed: "random-seed",
    lambda: "user-lambda",
  };
  const distributionFields = {
    uniform: ["size-min", "size-max"], normal: ["size-mean", "size-std"], beta: ["beta-alpha", "beta-beta"],
    exponential: ["size-rate"], bimodal: ["mixture-low", "mixture-high", "mixture-std", "mixture-weight"],
  };
  const distributionNames = { uniform: "Uniform", normal: "Truncated Gaussian", beta: "Beta", exponential: "Truncated exponential", bimodal: "Two-cluster Gaussian mixture" };
  function behaviorFromForm() {
    return Object.fromEntries(Object.entries(behaviorFields).map(([key, id]) => [key,
      typeof window.StaticBehavior.defaults[key] === "boolean" ? Boolean($(id).checked) : $(id).value]));
  }
  function applyBehaviorToForm(settings) {
    for (const [key, id] of Object.entries(behaviorFields)) {
      if (typeof settings[key] === "boolean") $(id).checked = settings[key]; else $(id).value = settings[key];
    }
    updateDistributionControls();
  }
  function behaviorSchema() {
    const properties = {};
    for (const [key, value] of Object.entries(window.StaticBehavior.defaults)) properties[key] = { type: typeof value, default: value };
    properties.sizeDistribution.enum = [...window.StaticBehavior.distributions];
    properties.lambda.minimum = 0; properties.lambda.maximum = 1;
    properties.seed.description = "Blank for fresh randomness, or a 32-bit unsigned integer as text.";
    return properties;
  }
  function updateDistributionControls() {
    const chosen = $("size-distribution").value;
    for (const [name, ids] of Object.entries(distributionFields)) {
      $("distribution-" + name).hidden = name !== chosen;
      for (const id of ids) $(id).disabled = name !== chosen;
    }
    const description = {
      uniform: "Equal density between the chosen minimum and maximum.",
      normal: "Draw from N(μ, σ²) conditional on [0, 1]. Out-of-range samples are redrawn, not clipped. Parameters describe the underlying Gaussian.",
      beta: "Beta(α, β) on [0, 1]. α = β gives a symmetric distribution; α < β favors smaller jobs; α > β favors larger jobs.",
      exponential: "Exponential(rate λ) conditional on [0, 1]. Larger λ concentrates jobs closer to zero.",
      bimodal: "Choose the low cluster with the specified share, then sample its Gaussian conditional on [0, 1]. Both clusters use the same standard deviation.",
    };
    $("distribution-description").textContent = description[chosen] || "Choose a true-size distribution.";
  }
  function updateBehaviorControls() {
    const feedback = Boolean($("feedback-enabled").checked);
    $("user-lambda").disabled = !feedback;
    $("user-response-note").textContent = feedback
      ? "One user submits all N jobs in order. λ = 0 keeps the base probability; λ = 1 gives the strongest response to past quality shortfalls."
      : "Feedback off: Hard is drawn with g₀(z). λ is retained but inactive; no quality history or penalty is used.";
  }
  function renderBehavior(result) {
    const { settings: s, firstUser: user, userTotals: totals } = result;
    $("learning-status").textContent = s.feedbackEnabled ? `Feedback on · λ = ${s.lambda}` : "Feedback off · g₀(z)";
    $("hard-share").textContent = `${format(result.hardShare * 100, 1)}%`;
    $("final-q-mean").textContent = `${format(result.finalRateMean * 100, 1)}%`;
    $("user-history-summary").textContent = s.feedbackEnabled
      ? `Across all ${s.trials} trials: ${totals.failures} shortfalls / ${totals.observedSimple} observed Simple jobs. Final q above is the mean of each trial's final ratio, with zero used when no Simple was observed.`
      : "History is disabled and q stays 0. Choices use g₀(z); the objective equals the reported-size bin count.";
    $("user-memory-table").innerHTML = `<tr><th scope="row">U1</th><td>${format(user.lambda, 3)}</td><td>${user.submissions}</td><td>${user.hardCount}</td><td>${user.observedSimple}</td><td>${user.failures}</td><td>${format(user.q * 100, 1)}%</td></tr>`;
    drawLearningChart(result);
    drawSizeHistogram(result);
  }
  function drawLearningChart(result) {
    const rounds = result.rounds, width = 760, height = 214, L = 46, R = 18, T = 20, B = 178;
    const stride = Math.max(1, Math.ceil(rounds.length / 60));
    let svg = `<svg viewBox="0 0 ${width} ${height}" aria-hidden="true">`;
    for (const p of [0, 0.5, 1]) {
      const y = B - p * (B - T);
      svg += `<line x1="${L}" y1="${y}" x2="${width-R}" y2="${y}" stroke="#e2eae7"/><text x="${L-8}" y="${y+4}" text-anchor="end" fill="#758b90" font-size="11">${p*100}%</text>`;
    }
    for (const [key, color, dash] of [["baseProbability", "#117890", "5 4"], ["hardProbability", "#d79a2d", ""], ["qBefore", "#8c6bb0", ""]]) {
      let path = "";
      for (let start = 0; start < rounds.length; start += stride) {
        const group = rounds.slice(start, start + stride);
        const jobs = group.reduce((n, bucket) => n + bucket.jobs, 0);
        const value = group.reduce((n, bucket) => n + bucket[key], 0) / jobs;
        const mid = (start + Math.min(rounds.length-1, start + stride-1)) / 2;
        const x = L + mid / Math.max(1, rounds.length-1) * (width-L-R), y = B - value * (B-T);
        path += `${path ? "L" : "M"}${x.toFixed(2)} ${y.toFixed(2)} `;
      }
      svg += `<path d="${path}" fill="none" stroke="${color}" stroke-width="2.5"${dash ? ` stroke-dasharray="${dash}"` : ""}/>`;
    }
    svg += `<text x="${L}" y="202" fill="#758b90" font-size="11">1</text><text x="${width-R}" y="202" text-anchor="end" fill="#758b90" font-size="11">${rounds.length}</text><text x="${width/2}" y="205" text-anchor="middle" fill="#758b90" font-size="12">Submission number · one user</text></svg>`;
    $("learning-chart").innerHTML = svg;
    $("learning-chart-note").textContent = `Base g₀(z), adjusted Hard probability and q before selection, averaged across ${result.settings.trials} independent trials. Each point also averages up to ${stride} consecutive submissions. These are probabilities, not binary mode draws. Each trial starts with q = 0.`;
  }
  function drawSizeHistogram(result) {
    const counts = Array(20).fill(0), sizes = result.firstSizes;
    sizes.forEach(x => { counts[Math.min(19, Math.floor(x * 20))] += 1; });
    const width = 760, height = 180, L = 40, R = 16, T = 15, B = 148, peak = Math.max(...counts, 1);
    let svg = `<svg viewBox="0 0 ${width} ${height}" aria-hidden="true">`;
    for (const proportion of [0, 0.5, 1]) {
      const y = B - proportion * (B-T);
      svg += `<line x1="${L}" y1="${y}" x2="${width-R}" y2="${y}" stroke="#e5ece9"/><text x="${L-6}" y="${y+4}" text-anchor="end" fill="#758b90" font-size="11">${Math.round(proportion*peak)}</text>`;
    }
    counts.forEach((n, i) => {
      const step = (width-L-R) / counts.length, h = n / peak * (B-T);
      svg += `<rect x="${L+i*step+1}" y="${B-h}" width="${step-3}" height="${h}" rx="2" fill="#117890" opacity=".78"/>`;
    });
    for (const value of [0, 0.25, 0.5, 0.75, 1]) svg += `<text x="${L+value*(width-L-R)}" y="172" text-anchor="middle" fill="#758b90" font-size="11">${value}</text>`;
    svg += "</svg>";
    $("size-histogram").innerHTML = svg;
    $("size-sample-summary").textContent = `${distributionNames[result.settings.sizeDistribution]} · mean ${format(mean(sizes), 3)}`;
    $("size-chart-note").textContent = `All ${sizes.length} true sizes from the first trial, before judgment error. Vertical axis: number of jobs per size interval. Seed: ${result.settings.seed === "" ? "fresh randomness" : result.settings.seed}.`;
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
    $("feedback-summary").textContent = result.settings.feedbackEnabled ? `Perceived-size feedback with s = ${result.settings.simpleThreshold}, c = ${result.settings.feedbackCoefficient}. Mean jobs with αⱼ > 0: ${format(result.feedbackJobMean)} of ${result.settings.jobs} per trial. Totals include every job in each trial.` : "Feedback is off: Hard is drawn using g₀(z), q stays 0 and every αⱼ = 0. Each objective equals its bin count.";
  }

  function render(result) {
    const layered = isTwoLayer(result.settings.algorithm);
    const baseLabel = algorithmLabels[baselineAlgorithm(result.settings.algorithm)];
    $("comparison-rule").textContent = layered
      ? `Same true jobs and submission order. Model 1 packs true sizes using ordinary ${baseLabel}; Model 2 uses ${algorithmLabels[result.settings.algorithm]} on reported sizes, with K = ${result.settings.reservationLimit}. The extra comparison below uses ordinary ${baseLabel} on the identical reported sequence, isolating the placement effect.`
      : "Both models use the selected algorithm and the same jobs in each trial. Model 1 packs true sizes; Model 2 packs reported sizes. One user draws a mode using g₀(z) and past quality history, then receives feedback after placement. Feedback can be switched off.";
    $("two-layer-results").hidden = !layered;
    if (layered) {
      const stats = result.reservationMeans;
      const saved = result.reportedBaselineMean - result.reportedMean;
      $("two-layer-comparison").textContent = `Same reported jobs: ordinary ${baseLabel} ${format(result.reportedBaselineMean, 2)} bins → ${algorithmLabels[result.settings.algorithm]} ${format(result.reportedMean, 2)} bins. Bins saved: ${saved > 0 ? "+" : ""}${format(saved, 2)} (negative = more bins). Feedback is identical for this comparison.`;
      $("two-layer-summary").textContent = `Simple-only reservations · K = ${result.settings.reservationLimit} · Matched pairs in reserved layer: ${format(stats.pairs, 2)} · Simple placed in existing ordinary Hard bins: ${format(stats.ordinaryHardFills, 2)} · Unmatched Simple reserved bins at end: ${format(stats.unmatched, 2)} · Threshold Simple arrivals sent to ordinary pool at limit: ${format(stats.overflow, 2)} · Ordinary bins: ${format(stats.ordinaryBins, 2)}. Hard is never reserved. Unmatched Simple reservations remain counted; no final repacking.`;
    }
    $("true-mean").textContent = format(result.trueMean);
    $("reported-mean").textContent = format(result.reportedMean);
    $("difference-mean").textContent = `${result.differenceMean > 0 ? "+" : ""}${format(result.differenceMean)}`;
    $("run-badge").textContent = `${algorithmLabels[result.settings.algorithm]} · ${result.settings.jobs} jobs × ${result.settings.trials} trials`;
    $("difference-note").textContent = result.differenceMean > 0 ? "Reported-size model uses more bins on average" : result.differenceMean < 0 ? "Reported-size model uses fewer bins on average" : "Both models use the same mean number of bins";
    drawMainChart(result);
    drawDifferenceChart(result);
    renderFeedback(result);
    renderBehavior(result);
    $("sample-table").innerHTML = result.firstRows.map((row) => {
      const quality = !result.settings.feedbackEnabled ? "Off" : row.qualityFailed ? "Shortfall" : "Met";
      const rate = `${format(row.expectedBefore * 100, 1)}% → ${format(row.expectedAfter * 100, 1)}%`;
      const field = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
      return `<tr><th scope="row">#${row.id}</th><td><span class="job-size-flow"><span><small>a</small>${format(row.actual, 3)}</span><span><small>z</small>${format(row.perceived, 3)}</span><span><small>r</small>${format(row.reported, 3)}</span></span></td><td><span class="job-mode ${row.hard ? "is-hard" : "is-simple"}">${row.hard ? "Hard" : "Simple"}</span></td><td><span class="job-quality ${row.qualityFailed ? "has-shortfall" : ""}">${quality}</span></td><td>${row.reportedBin}</td><td><button type="button" class="job-details-button" data-job-details="${row.id}" aria-expanded="false" aria-controls="job-details-${row.id}" aria-label="Show details for job ${row.id}">View</button></td></tr>
      <tr class="job-detail-row" id="job-details-${row.id}" hidden><td colspan="6"><div class="job-detail-panel"><section><h4>Mode draw · U1</h4><dl>${field("Sensitivity λ", format(row.lambda, 3))}${field("Base g₀(z)", `${format(row.baseProbability * 100, 2)}%`)}${field("Adjusted Hard probability", `${format(row.hardProbability * 100, 2)}%`)}${field("Uniform draw v", format(row.draw, 4))}</dl></section><section><h4>Quality &amp; history</h4><dl>${field("Quality shortfall", quality)}${field("Feedback α", format(row.feedback, 4))}${field("Failed / observed Simple", row.observedSimple ? `${row.failures}/${row.observedSimple}` : "No observations")}${field("q before → after", rate)}</dl></section><section><h4>Placement</h4><dl>${field("Submission number", row.submission)}${field("Model 1 bin · true size", row.trueBin)}${field("Model 2 bin · report", row.reportedBin)}${row.placementLayer ? field("Placement route at arrival", row.placementLayer) : ""}</dl></section></div></td></tr>`;
    }).join("");

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
    const algorithm = $("packing-algorithm").value;
    const description = algorithmDescriptions[algorithm];
    const layered = isTwoLayer(algorithm);
    $("algorithm-description").textContent = description;
    $("reservation-controls").hidden = !layered;
    $("reservation-limit").disabled = !layered;
    $("selected-algorithm-rule").textContent = layered
      ? `${description} With K > 0, threshold Simple checks existing ordinary Hard bins before reservation or overflow. At most K threshold Simple bins are reserved. Hard never opens a reservation; matching takes priority even at the limit. Jobs never move after placement. K = 0 uses ordinary FF/BF without special priority. Requires s + h = 1. Model 1 uses ordinary ${algorithmLabels[baselineAlgorithm(algorithm)]}.`
      : `${description} Both models use this same placement rule.`;
    updateComplementaryStatus();
  }

  function updateComplementaryStatus() {
    const s = Number($("simple-threshold").value), h = Number($("hard-threshold").value);
    const validS = s > 0 && s < 0.5;
    const complementary = validS && h > 0.5 && h < 1 && Math.abs(s + h - 1) <= 1e-12;
    $("complementary-status").textContent = complementary ? `Complementary bounds ready: s = ${s}, h = ${h}.`
      : validS ? `Current s + h = ${format(s + h, 3)}. Set h to ${Number((1 - s).toPrecision(15))} before running 双层 FF/BF.`
      : "Set Simple upper bound s strictly between 0 and 0.5, then set h = 1 − s.";
    $("complementary-bounds").disabled = !validS;
  }

  function updateFeedbackControls() {
    $("feedback-coefficient").disabled = !$("feedback-enabled").checked;
    updateBehaviorControls();
  }

  $("sample-table").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-job-details]");
    if (!button) return;
    const row = $(button.getAttribute("aria-controls"));
    if (!row) return;
    const expanded = button.getAttribute("aria-expanded") !== "true";
    row.hidden = !expanded;
    button.setAttribute("aria-expanded", String(expanded));
    button.setAttribute("aria-label", `${expanded ? "Hide" : "Show"} details for job ${button.getAttribute("data-job-details")}`);
    button.textContent = expanded ? "Hide" : "View";
  });
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
  $("simple-threshold").addEventListener("input", updateComplementaryStatus);
  $("hard-threshold").addEventListener("input", updateComplementaryStatus);
  $("complementary-bounds").addEventListener("click", () => {
    const s = Number($("simple-threshold").value);
    if (s > 0 && s < 0.5) $("hard-threshold").value = Number((1 - s).toPrecision(15));
    updateComplementaryStatus();
  });
  $("feedback-enabled").addEventListener("change", updateFeedbackControls);
  $("size-distribution").addEventListener("change", updateDistributionControls);
  drawProbabilityCurve();
  updateErrorDescription();
  updateAlgorithmDescription();
  updateFeedbackControls();
  updateDistributionControls();
  executeFromForm();

  // Browser agents can run the same visible experiment without a separate backend.
  if (document.modelContext?.registerTool) {
    const schema = {
      type: "object",
      properties: {
        jobs: { type: "integer", minimum: 500, maximum: 5000 },
        trials: { type: "integer", minimum: 1, maximum: 300 },
        algorithm: { type: "string", enum: Object.keys(packers) },
        reservationLimit: { type: "integer", minimum: 0, maximum: 5000, default: 10, description: "Maximum unmatched threshold Simple bins; Hard is never reserved. Used only by two-layer FF/BF. Zero disables reservations." },
        probabilityExpression: { type: "string", minLength: 1, maxLength: 180 },
        simpleThreshold: { type: "number", minimum: 0, maximum: 1 },
        hardThreshold: { type: "number", minimum: 0, maximum: 1 },
        errorType: { type: "string", enum: [...errorTypes] },
        errorScale: { type: "number", minimum: 0, maximum: 1 },
        ...behaviorSchema(),
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
        description: "Run paired static trials for one user with optional history-adjusted mode probabilities and quality penalties.",
        inputSchema: schema,
        annotations: { readOnlyHint: false, untrustedContentHint: false },
        async execute(input) {
          const settings = validate(input);
          const mapping = { jobs: "job-count", trials: "trial-count", algorithm: "packing-algorithm", reservationLimit: "reservation-limit", probabilityExpression: "probability-expression", simpleThreshold: "simple-threshold", hardThreshold: "hard-threshold", errorType: "error-type", errorScale: "error-scale", feedbackCoefficient: "feedback-coefficient" };
          Object.entries(mapping).forEach(([key, id]) => { $(id).value = settings[key]; });
          applyBehaviorToForm(settings);
          $("feedback-enabled").checked = settings.feedbackEnabled;
          $("probability-expression").dispatchEvent(new Event("input"));
          updateErrorDescription();
          updateAlgorithmDescription();
          updateFeedbackControls();
          drawProbabilityCurve();
          const result = await executeSettings(settings);
          return { trueMean: result.trueMean, reportedMean: result.reportedMean, differenceMean: result.differenceMean, feedbackMean: result.feedbackMean, feedbackJobMean: result.feedbackJobMean, objectiveMean: result.objectiveMean, objectiveDifferenceMean: result.objectiveDifferenceMean, feedbackEnabled: settings.feedbackEnabled, feedbackCoefficient: settings.feedbackCoefficient, userCount: 1, lambda: settings.lambda, hardShare: result.hardShare, finalRateMean: result.finalRateMean, sizeDistribution: settings.sizeDistribution, trials: settings.trials, reservationLimit: settings.reservationLimit, reservationMeans: result.reservationMeans, reportedBaselineMean: result.reportedBaselineMean };
        },
      })).catch(() => {});
    } catch (_) { /* The normal page works without WebMCP. */ }
  }
})();
