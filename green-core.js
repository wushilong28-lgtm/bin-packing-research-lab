(() => {
  "use strict";

  const EPS = 1e-12;
  const ALGORITHMS = ["first-fit", "best-fit", "next-fit", "worst-fit", "harmonic"];
  const LABELS = {
    "first-fit": "First Fit",
    "best-fit": "Best Fit",
    "next-fit": "Next Fit",
    "worst-fit": "Worst Fit",
    harmonic: "Harmonic",
  };

  function seededRandom(seed) {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
  }

  function noise(type, scale, random) {
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

  function sampleTrial(settings, probability, random) {
    const actual = new Float64Array(settings.jobs);
    const perceived = new Float64Array(settings.jobs);
    const reported = new Float64Array(settings.jobs);
    const hardModes = new Uint8Array(settings.jobs);
    for (let i = 0; i < settings.jobs; i += 1) {
      const size = random();
      const z = clamp(size + noise(settings.errorType, settings.errorScale, random), 0, 1);
      const hard = random() < probability(z);
      actual[i] = size;
      perceived[i] = z;
      hardModes[i] = hard ? 1 : 0;
      reported[i] = hard ? Math.max(settings.hardThreshold, z) : Math.min(settings.simpleThreshold, z);
    }
    return { actual, perceived, hardModes, reported };
  }

  function firstFit(sizes, effectiveCapacity, assignments) {
    let base = 1;
    while (base < sizes.length) base *= 2;
    const remaining = new Float64Array(base * 2);
    remaining.fill(-1);
    const loads = [];
    for (const size of sizes) {
      let node;
      if (size > effectiveCapacity + EPS) {
        loads.push(size);
        node = base + loads.length - 1;
        remaining[node] = -1;
      } else if (loads.length === 0 || remaining[1] + EPS < size) {
        loads.push(size);
        node = base + loads.length - 1;
        remaining[node] = Math.max(0, effectiveCapacity - size);
      } else {
        node = 1;
        while (node < base) {
          node = remaining[node * 2] + EPS >= size ? node * 2 : node * 2 + 1;
        }
        const index = node - base;
        loads[index] += size;
        remaining[node] = Math.max(0, effectiveCapacity - loads[index]);
      }
      if (assignments && assignments.length < 100) assignments.push(node - base + 1);
      while (node > 1) {
        node = Math.floor(node / 2);
        remaining[node] = Math.max(remaining[node * 2], remaining[node * 2 + 1]);
      }
    }
    return loads;
  }

  function orderedFit(sizes, effectiveCapacity, useWorst, assignments) {
    // Treap keys are remaining capacity and then opening order.
    const compare = (a, b) => a.remaining - b.remaining || a.order - b.order;
    const count = (node) => node?.count ?? 0;
    const update = (node) => { node.count = 1 + count(node.left) + count(node.right); return node; };
    const merge = (a, b) => {
      if (!a) return b;
      if (!b) return a;
      if (a.priority < b.priority) { a.right = merge(a.right, b); return update(a); }
      b.left = merge(a, b.left);
      return update(b);
    };
    const insert = (root, node) => {
      if (!root) return node;
      if (compare(node, root) < 0) {
        root.left = insert(root.left, node);
        if (root.left.priority < root.priority) {
          const pivot = root.left;
          root.left = pivot.right;
          pivot.right = root;
          update(root);
          return update(pivot);
        }
      } else {
        root.right = insert(root.right, node);
        if (root.right.priority < root.priority) {
          const pivot = root.right;
          root.right = pivot.left;
          pivot.left = root;
          update(root);
          return update(pivot);
        }
      }
      return update(root);
    };
    const remove = (root, node) => {
      if (root === node) return merge(root.left, root.right);
      if (compare(node, root) < 0) root.left = remove(root.left, node);
      else root.right = remove(root.right, node);
      return update(root);
    };
    const priorityFor = (order) => {
      let value = (order + 1) ^ 0x9e3779b9;
      value ^= value << 13;
      value ^= value >>> 17;
      value ^= value << 5;
      return value >>> 0;
    };
    const loads = [];
    let root = null;
    for (const size of sizes) {
      if (size > effectiveCapacity + EPS) {
        loads.push(size);
        if (assignments && assignments.length < 100) assignments.push(loads.length);
        continue;
      }
      let chosen = null;
      let cursor = root;
      if (useWorst) {
        while (cursor?.right) cursor = cursor.right;
        if (cursor && cursor.remaining + EPS >= size) {
          const mostSpace = cursor.remaining;
          cursor = root;
          while (cursor) {
            if (cursor.remaining >= mostSpace) { chosen = cursor; cursor = cursor.left; }
            else cursor = cursor.right;
          }
        }
      } else {
        while (cursor) {
          if (cursor.remaining + EPS >= size) { chosen = cursor; cursor = cursor.left; }
          else cursor = cursor.right;
        }
      }
      if (chosen) {
        if (assignments && assignments.length < 100) assignments.push(chosen.order + 1);
        root = remove(root, chosen);
        loads[chosen.order] += size;
        chosen.remaining = Math.max(0, effectiveCapacity - loads[chosen.order]);
        chosen.left = null;
        chosen.right = null;
        chosen.count = 1;
        root = insert(root, chosen);
      } else {
        const order = loads.length;
        loads.push(size);
        if (assignments && assignments.length < 100) assignments.push(order + 1);
        root = insert(root, { remaining: Math.max(0, effectiveCapacity - size), order, priority: priorityFor(order), left: null, right: null, count: 1 });
      }
    }
    return loads;
  }

  function nextFit(sizes, effectiveCapacity, assignments) {
    const loads = [];
    let current = -1;
    for (const size of sizes) {
      if (size > effectiveCapacity + EPS) {
        loads.push(size);
        current = -1;
      } else if (current < 0 || loads[current] + size > effectiveCapacity + EPS) {
        current = loads.length;
        loads.push(size);
      } else {
        loads[current] += size;
      }
      if (assignments && assignments.length < 100) assignments.push(size > effectiveCapacity + EPS ? loads.length : current + 1);
    }
    return loads;
  }

  function harmonicClass(size, effectiveCapacity, classes) {
    if (size === 0) return classes - 1;
    const normalized = size / effectiveCapacity;
    return Math.min(classes, Math.max(1, Math.floor(1 / normalized))) - 1;
  }

  function harmonic(sizes, effectiveCapacity, classes = 10, assignments) {
    const loads = [];
    const active = new Int32Array(classes);
    active.fill(-1);
    for (const size of sizes) {
      if (size > effectiveCapacity + EPS) {
        loads.push(size);
        if (assignments && assignments.length < 100) assignments.push(loads.length);
        continue;
      }
      const group = effectiveCapacity === 0 ? classes - 1 : harmonicClass(size, effectiveCapacity, classes);
      let index = active[group];
      if (index < 0 || loads[index] + size > effectiveCapacity + EPS) {
        index = loads.length;
        loads.push(size);
        active[group] = index;
      } else {
        loads[index] += size;
      }
      if (assignments && assignments.length < 100) assignments.push(index + 1);
    }
    return loads;
  }

  function pack(sizes, algorithm, effectiveCapacity, harmonicClasses = 10, assignments) {
    if (!ALGORITHMS.includes(algorithm)) throw new Error("Unknown placement algorithm.");
    if (!Number.isFinite(effectiveCapacity) || effectiveCapacity < 0 || effectiveCapacity > 1) throw new Error("Effective capacity must be between 0 and 1.");
    for (const size of sizes) {
      if (!Number.isFinite(size) || size < 0 || size > 1) throw new Error("Reported sizes must be between 0 and 1.");
    }
    if (algorithm === "first-fit") return firstFit(sizes, effectiveCapacity, assignments);
    if (algorithm === "best-fit") return orderedFit(sizes, effectiveCapacity, false, assignments);
    if (algorithm === "worst-fit") return orderedFit(sizes, effectiveCapacity, true, assignments);
    if (algorithm === "next-fit") return nextFit(sizes, effectiveCapacity, assignments);
    return harmonic(sizes, effectiveCapacity, harmonicClasses, assignments);
  }

  function cost(loads, greenCapacity, blackPrice) {
    if (!Number.isFinite(greenCapacity) || greenCapacity < 0 || greenCapacity > 1) throw new Error("G must be between 0 and 1.");
    if (!Number.isFinite(blackPrice) || blackPrice <= 0) throw new Error("β must be positive.");
    let blackVolume = 0;
    for (const load of loads) {
      if (!Number.isFinite(load) || load < -EPS || load > 1 + EPS) throw new Error("A reported bin load exceeds physical capacity 1.");
      blackVolume += Math.max(0, load - greenCapacity);
    }
    return { bins: loads.length, openingCost: loads.length, blackVolume, blackCost: blackPrice * blackVolume, total: loads.length + blackPrice * blackVolume };
  }

  const api = { ALGORITHMS, LABELS, seededRandom, sampleTrial, harmonicClass, pack, cost };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof window !== "undefined") window.GreenPacking = api;
})();
