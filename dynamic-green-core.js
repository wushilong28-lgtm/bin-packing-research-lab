(() => {
  "use strict";

  const EPS = 1e-10;
  const NON_CLAIRVOYANT = ["first-fit", "mru", "next-fit", "round-robin-next-fit", "best-fit"];
  const CLAIRVOYANT = ["departure-class", "nrt", "prioritized-nrt", "greedy", "duration-class"];
  const ALGORITHMS = [...NON_CLAIRVOYANT, ...CLAIRVOYANT];
  const LABELS = {
    "first-fit": "First Fit", mru: "Most Recently Used", "next-fit": "Next Fit",
    "round-robin-next-fit": "Round Robin Next Fit", "best-fit": "Best Fit",
    "departure-class": "Classify by Departure Time", nrt: "Nearest Remaining Time",
    "prioritized-nrt": "Prioritized NRT", greedy: "Greedy", "duration-class": "Classify by Duration",
  };
  const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

  function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  function sizeNoise(type, scale, random) {
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
    return scale * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * random());
  }

  function durationProbability(duration, midpoint, width) {
    const x = (duration - midpoint) / width;
    if (x >= 40) return 1;
    if (x <= -40) return 0;
    return 1 / (1 + Math.exp(-x));
  }

  function combinedProbability(sizeProbability, timeProbability, timeWeight) {
    return (1 - timeWeight) * sizeProbability + timeWeight * timeProbability;
  }

  function sampleTrial(settings, probability, random) {
    const jobs = [];
    let arrival = 0;
    for (let i = 0; i < settings.jobs; i += 1) {
      if (i > 0) {
        arrival += settings.arrivalPattern === "fixed"
          ? settings.arrivalInterval
          : -settings.arrivalInterval * Math.log(Math.max(Number.MIN_VALUE, 1 - random()));
      }
      const actualSize = random();
      const actualDuration = settings.durationMin + (settings.durationMax - settings.durationMin) * random();
      const estimatedSize = clamp(actualSize + sizeNoise(settings.errorType, settings.errorScale, random), 0, 1);
      const estimatedDuration = actualDuration * (1 + (2 * random() - 1) * settings.durationError);
      const sizeHardProbability = probability(estimatedSize);
      const timeHardProbability = durationProbability(estimatedDuration, settings.durationMidpoint, settings.durationWidth);
      const hardProbability = combinedProbability(sizeHardProbability, timeHardProbability, settings.timeWeight);
      const hard = random() < hardProbability;
      const reportedSize = hard ? Math.max(settings.hardSize, estimatedSize) : Math.min(settings.simpleSize, estimatedSize);
      const reportedDuration = hard ? Math.max(settings.hardDuration, estimatedDuration) : Math.min(settings.simpleDuration, estimatedDuration);
      jobs.push({ id: i + 1, arrival, actualSize, actualDuration, estimatedSize, estimatedDuration,
        sizeHardProbability, timeHardProbability, hardProbability, hard,
        reportedSize, reportedDuration, departure: arrival + reportedDuration });
    }
    return jobs;
  }

  function simulate(jobs, algorithm, effectiveCapacity, greenCapacity, blackPrice, categoryWidth = 2, capture = false) {
    if (![...ALGORITHMS, "full-first-fit"].includes(algorithm)) throw new Error("Unknown algorithm.");
    if (!Number.isFinite(effectiveCapacity) || effectiveCapacity < 0 || effectiveCapacity > 1) throw new Error("Invalid effective capacity.");
    if (!Number.isFinite(greenCapacity) || greenCapacity < 0 || greenCapacity > 1 || !Number.isFinite(blackPrice) || blackPrice <= 0) throw new Error("Invalid Green cost settings.");
    const selectedAlgorithm = algorithm === "full-first-fit" ? "first-fit" : algorithm;
    const capacity = algorithm === "full-first-fit" ? 1 : effectiveCapacity;
    const bins = new Map();
    const departures = [];
    const events = [];
    const assignments = [];
    let nextFitCurrent = null;
    let roundRobinFlag = null;
    let accessOrder = 0;
    let opened = 0;
    let peakBins = 0;
    let binTime = 0;
    let blackTime = 0;
    let now = 0;
    let blackVolume = 0;

    function record() {
      if (capture) events.push({ time: now, activeBins: bins.size, blackVolume });
    }
    function advance(time) {
      const span = time - now;
      if (span < -EPS) throw new Error("Events are not ordered by time.");
      binTime += bins.size * Math.max(0, span);
      blackTime += blackVolume * Math.max(0, span);
      now = time;
    }
    function heapPush(item) {
      let index = departures.length;
      departures.push(item);
      while (index > 0) {
        const parent = Math.floor((index - 1) / 2);
        if (departures[parent].time <= item.time) break;
        departures[index] = departures[parent];
        index = parent;
      }
      departures[index] = item;
    }
    function heapPop() {
      const first = departures[0];
      const last = departures.pop();
      if (departures.length) {
        let index = 0;
        while (index * 2 + 1 < departures.length) {
          let child = index * 2 + 1;
          if (child + 1 < departures.length && departures[child + 1].time < departures[child].time) child += 1;
          if (departures[child].time >= last.time) break;
          departures[index] = departures[child];
          index = child;
        }
        departures[index] = last;
      }
      return first;
    }
    function adjustBlack(oldLoad, newLoad) {
      blackVolume += Math.max(0, newLoad - greenCapacity) - Math.max(0, oldLoad - greenCapacity);
      if (Math.abs(blackVolume) < EPS) blackVolume = 0;
    }
    function release(until) {
      while (departures.length && departures[0].time <= until) {
        const item = heapPop();
        advance(item.time);
        const bin = bins.get(item.binId);
        if (!bin) throw new Error("Departure refers to a closed bin.");
        const oldLoad = bin.load;
        bin.load = Math.max(0, oldLoad - item.size);
        bin.count -= 1;
        bin.members.delete(item.jobId);
        bin.closing = bin.members.size ? Math.max(...bin.members.values()) : -Infinity;
        adjustBlack(oldLoad, bin.load);
        if (bin.count === 0) {
          bins.delete(bin.id);
          if (nextFitCurrent === bin.id) nextFitCurrent = null;
        }
        record();
      }
    }
    function open(size, category, singleton) {
      const bin = { id: ++opened, load: size, count: 0, category, singleton,
        closing: -Infinity, lastAccess: ++accessOrder, members: new Map() };
      bins.set(bin.id, bin);
      adjustBlack(0, size);
      if (bins.size > peakBins) peakBins = bins.size;
      return bin;
    }
    function choose(job, category) {
      const size = job.reportedSize;
      if (selectedAlgorithm === "next-fit") {
        const current = bins.get(nextFitCurrent);
        return current && !current.singleton && current.load + size <= capacity + EPS ? current : null;
      }
      if (selectedAlgorithm === "round-robin-next-fit") {
        const open = [...bins.values()].filter((bin) => !bin.singleton);
        if (!open.length) return null;
        let start = open.findIndex((bin) => bin.id >= roundRobinFlag);
        if (start < 0) start = 0;
        for (let offset = 0; offset < open.length; offset += 1) {
          const bin = open[(start + offset) % open.length];
          if (bin.load + size <= capacity + EPS) return bin;
        }
        return null;
      }
      let chosen = null;
      for (const bin of bins.values()) {
        if (bin.singleton || bin.load + size > capacity + EPS) continue;
        if ((selectedAlgorithm === "departure-class" || selectedAlgorithm === "duration-class") && bin.category !== category) continue;
        if (!chosen) { chosen = bin; continue; }
        if (selectedAlgorithm === "best-fit" && bin.load > chosen.load + EPS) chosen = bin;
        if (selectedAlgorithm === "mru" && bin.lastAccess > chosen.lastAccess) chosen = bin;
        if (selectedAlgorithm === "greedy" && bin.closing > chosen.closing + EPS) chosen = bin;
        if (selectedAlgorithm === "nrt" && Math.abs(bin.closing - job.departure) < Math.abs(chosen.closing - job.departure) - EPS) chosen = bin;
        if (selectedAlgorithm === "prioritized-nrt") {
          const binCovers = bin.closing >= job.departure - EPS;
          const chosenCovers = chosen.closing >= job.departure - EPS;
          if ((binCovers && !chosenCovers) || (binCovers === chosenCovers && Math.abs(bin.closing - job.departure) < Math.abs(chosen.closing - job.departure) - EPS)) chosen = bin;
        }
      }
      return chosen;
    }

    for (const job of jobs) {
      if (!Number.isFinite(job.arrival) || !Number.isFinite(job.departure) || !Number.isFinite(job.reportedSize) || job.reportedSize < 0 || job.reportedSize > 1 || job.departure <= job.arrival) throw new Error("Invalid reported job.");
      release(job.arrival);
      advance(job.arrival);
      const singleton = job.reportedSize > capacity + EPS;
      const category = selectedAlgorithm === "departure-class" ? Math.floor(job.departure / categoryWidth)
        : selectedAlgorithm === "duration-class" ? Math.floor(Math.log2(job.reportedDuration)) : null;
      let bin = singleton ? null : choose(job, category);
      if (bin) {
        const oldLoad = bin.load;
        bin.load += job.reportedSize;
        adjustBlack(oldLoad, bin.load);
      } else {
        bin = open(job.reportedSize, category, singleton);
        if (selectedAlgorithm === "next-fit") nextFitCurrent = singleton ? null : bin.id;
      }
      bin.count += 1;
      bin.members.set(job.id, job.departure);
      bin.closing = Math.max(bin.closing, job.departure);
      bin.lastAccess = ++accessOrder;
      if (selectedAlgorithm === "round-robin-next-fit") roundRobinFlag = bin.id;
      heapPush({ time: job.departure, binId: bin.id, size: job.reportedSize, jobId: job.id });
      if (capture) assignments.push({ jobId: job.id, binId: bin.id });
      record();
    }
    release(Infinity);
    return { total: binTime + blackPrice * blackTime, binTime, blackTime, blackCost: blackPrice * blackTime,
      opened, peakBins, horizon: now, events, assignments };
  }

  const api = { NON_CLAIRVOYANT, CLAIRVOYANT, ALGORITHMS, LABELS, seededRandom,
    sizeNoise, durationProbability, combinedProbability, sampleTrial, simulate };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.DynamicGreen = api;
})();
