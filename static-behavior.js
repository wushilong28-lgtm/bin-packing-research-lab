/* Static experiment: bounded true-size distributions and one user's quality history. */
(function (root) {
  "use strict";
  const distributions = new Set(["uniform", "normal", "beta", "exponential", "bimodal"]);
  const defaults = {
    sizeDistribution: "uniform", sizeMin: 0, sizeMax: 1, sizeMean: 0.5, sizeStd: 0.15,
    betaAlpha: 2, betaBeta: 5, sizeRate: 3, mixtureWeight: 0.5,
    mixtureLow: 0.25, mixtureHigh: 0.75, mixtureStd: 0.08,
    lambda: 0.5, seed: "",
  };
  function settings(raw) {
    const s = {};
    for (const [key, value] of Object.entries(defaults)) {
      s[key] = typeof value === "number" ? Number(raw[key] ?? value) : raw[key] ?? value;
    }
    const check = (ok, message) => { if (!ok) throw new Error(message); };
    const between = (x, a, b) => Number.isFinite(x) && x >= a && x <= b;
    check(distributions.has(s.sizeDistribution), "Choose a supported true-size distribution.");
    if (s.sizeDistribution === "uniform") check(between(s.sizeMin, 0, 1) && between(s.sizeMax, 0, 1) && s.sizeMin < s.sizeMax, "Uniform bounds must satisfy 0 ≤ min < max ≤ 1.");
    if (s.sizeDistribution === "normal") check(between(s.sizeMean, 0, 1) && between(s.sizeStd, 0.01, 1), "Gaussian mean must be in [0, 1] and standard deviation in [0.01, 1].");
    if (s.sizeDistribution === "beta") check(between(s.betaAlpha, 0.1, 50) && between(s.betaBeta, 0.1, 50), "Beta shapes must be between 0.1 and 50.");
    if (s.sizeDistribution === "exponential") check(between(s.sizeRate, 0.01, 100), "Exponential rate must be between 0.01 and 100.");
    if (s.sizeDistribution === "bimodal") check(between(s.mixtureWeight, 0, 1) && between(s.mixtureLow, 0, 1) && between(s.mixtureHigh, 0, 1) && s.mixtureLow < s.mixtureHigh && between(s.mixtureStd, 0.01, 1), "Mixture needs 0 ≤ low mean < high mean ≤ 1, standard deviation in [0.01, 1], and a weight in [0, 1].");
    check(between(s.lambda, 0, 1), "Feedback sensitivity λ must be a finite number between 0 and 1.");
    s.seed = String(s.seed).trim();
    check(s.seed === "" || (/^\d+$/.test(s.seed) && between(Number(s.seed), 0, 4294967295)), "Seed must be blank or an integer from 0 to 4294967295.");
    return s;
  }
  function rng(seed) {
    let state = seed >>> 0;
    return () => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function normal(random) {
    return Math.sqrt(-2 * Math.log(Math.max(Number.MIN_VALUE, random()))) * Math.cos(2 * Math.PI * random());
  }
  function truncatedNormal(mu, sigma, random) {
    // Conditional law on [0,1]; no artificial atoms at the endpoints.
    let x;
    do { x = mu + sigma * normal(random); } while (x < 0 || x > 1);
    return x;
  }
  function gamma(shape, random) {
    if (shape < 1) return gamma(shape + 1, random) * Math.pow(Math.max(Number.MIN_VALUE, random()), 1 / shape);
    const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      const x = normal(random), v0 = 1 + c * x;
      if (v0 <= 0) continue;
      const v = v0 * v0 * v0, u = Math.max(Number.MIN_VALUE, random());
      if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  }
  function sampleSize(s, random = Math.random) {
    if (s.sizeDistribution === "normal") return truncatedNormal(s.sizeMean, s.sizeStd, random);
    if (s.sizeDistribution === "beta") { const x = gamma(s.betaAlpha, random), y = gamma(s.betaBeta, random); return x / (x + y); }
    if (s.sizeDistribution === "exponential") return -Math.log1p(-random() * -Math.expm1(-s.sizeRate)) / s.sizeRate;
    if (s.sizeDistribution === "bimodal") return truncatedNormal(random() < s.mixtureWeight ? s.mixtureLow : s.mixtureHigh, s.mixtureStd, random);
    return s.sizeMin + random() * (s.sizeMax - s.sizeMin);
  }
  function createUser(s) {
    return { id: 1, lambda: s.lambda, q: 0, submissions: 0, hardCount: 0,
      feedback: 0, observedSimple: 0, failures: 0 };
  }
  // This decision never receives true size, current report, or private s/h.
  function chooseMode(user, baseProbability, feedbackEnabled, draw) {
    const expectedBefore = feedbackEnabled ? user.q : 0;
    const hardProbability = baseProbability + (feedbackEnabled ? user.lambda * expectedBefore * (1 - baseProbability) : 0);
    return { hard: draw < hardProbability, baseProbability, hardProbability, draw, expectedBefore,
      observationsBefore: user.observedSimple, failuresBefore: user.failures };
  }
  function receiveFeedback(user, outcome, feedbackEnabled) {
    user.submissions += 1;
    user.hardCount += Number(outcome.hard);
    user.feedback += outcome.feedback;
    // Hard gives no counterfactual Simple observation; successful Simple counts.
    if (!outcome.hard && feedbackEnabled) {
      user.observedSimple += 1;
      user.failures += Number(outcome.qualityFailed);
      user.q = user.failures / user.observedSimple;
    }
  }
  const api = { defaults, distributions, settings, rng, sampleSize, createUser, chooseMode, receiveFeedback };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.StaticBehavior = api;
})(typeof window === "undefined" ? globalThis : window);
