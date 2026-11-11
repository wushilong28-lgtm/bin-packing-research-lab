const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const html = fs.readFileSync(path.join(root, "dynamic-green.html"), "utf8");

test("dynamic page connects local assets and every referenced control", () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size, "HTML IDs must be unique");
  const ui = fs.readFileSync(path.join(root, "dynamic-green.js"), "utf8");
  const referenced = [...ui.matchAll(/\$\("([^"]+)"\)|value\("([^"]+)"\)/g)].map((match) => match[1] || match[2]);
  for (const id of referenced) assert.ok(ids.includes(id), `Missing control #${id}`);
  for (const match of html.matchAll(/(?:src|href)="\.\/([^"]+)"/g)) {
    assert.ok(fs.existsSync(path.join(root, match[1])), `Missing asset ${match[1]}`);
  }
});

test("dynamic page completes its default local run", async () => {
  const elements = new Map();
  const tags = [...html.matchAll(/<(input|select|button|div|p|tbody|section|svg|form)[^>]*\bid="([^"]+)"[^>]*>/g)];
  for (const [, tag, id] of tags) {
    const opening = tags.find((match) => match[2] === id)?.[0] || "";
    const value = opening.match(/\bvalue="([^"]*)"/)?.[1] || "";
    elements.set(id, {
      value, textContent: "", innerHTML: "", hidden: false, disabled: false,
      attributes: new Map(), listeners: new Map(),
      addEventListener(name, listener) { this.listeners.set(name, listener); },
      setAttribute(name, value) { this.attributes.set(name, value); },
      removeAttribute(name) { this.attributes.delete(name); },
      getAttribute(name) { return this.attributes.get(name) ?? null; },
    });
  }
  for (const [id, value] of [["arrival-pattern", "exponential"], ["error-type", "normal"],
    ["probability-preset", "logistic"], ["inspect-algorithm", "first-fit"]]) elements.get(id).value = value;
  const button = { disabled: false, textContent: "", innerHTML: "" };
  elements.get("dynamic-form").querySelector = () => button;
  const context = {
    window: {}, document: { getElementById: (id) => elements.get(id) || null },
    requestAnimationFrame: (callback) => setImmediate(callback),
  };
  for (const file of ["probability.js", "dynamic-green-core.js", "dynamic-green.js"]) {
    vm.runInNewContext(fs.readFileSync(path.join(root, file), "utf8"), context, { filename: file });
  }
  const started = Date.now();
  while (elements.get("best-cost").textContent === "" && Date.now() - started < 5000) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (!elements.get("form-error").hidden && elements.get("form-error").textContent) break;
  }
  assert.equal(elements.get("form-error").textContent, "");
  assert.ok(Number.isFinite(Number(elements.get("best-cost").textContent)));
  assert.match(elements.get("cost-chart").innerHTML, /Greedy/);
  assert.match(elements.get("sample-table").innerHTML, /Hard|Simple/);
  assert.equal((elements.get("sample-table").innerHTML.match(/<tr>/g) || []).length, 100);
  assert.match(elements.get("timeline-chart").innerHTML, /<svg/);
});
