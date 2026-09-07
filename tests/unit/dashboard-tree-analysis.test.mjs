import assert from "node:assert/strict";
import test from "node:test";
import {
  summarizeAccessibilityTree,
  summarizeDomTree,
} from "../e2e/dashboard-tree-analysis.mjs";

test("dashboard tree analysis identifies dominant DOM structures", () => {
  const result = summarizeDomTree([
    { tag: "main", classes: ["shell"], depth: 1, childElementCount: 2 },
    { tag: "section", classes: ["panel"], depth: 2, childElementCount: 1 },
    { tag: "span", classes: ["panel", "label"], depth: 3, childElementCount: 0 },
  ], [
    { tag: "section", viewId: "small", descendantElements: 1 },
    { tag: "main", viewId: "large", descendantElements: 2 },
  ]);

  assert.equal(result.totalElements, 3);
  assert.equal(result.depth.maximum, 3);
  assert.deepEqual(result.byTag[0], { name: "main", count: 1 });
  assert.deepEqual(result.byClass[0], { name: "panel", count: 2 });
  assert.equal(result.topStructures[0].viewId, "large");
});

test("accessibility tree analysis reports roles, depth, and structural issues", () => {
  const result = summarizeAccessibilityTree(`
- main:
  - heading "Dashboard" [level=1]
  - heading "Details" [level=3]
  - button
  - link "Open"
    - /url: "#open"
  - link "Open"
`);

  assert.equal(result.totalNodes, 6);
  assert.equal(result.depth.maximum, 1);
  assert.deepEqual(result.byRole[0], { name: "heading", count: 2 });
  assert.deepEqual(result.issues.unnamedInteractive, [{ role: "button", depth: 1 }]);
  assert.deepEqual(result.issues.headingLevelJumps, [{ from: 1, to: 3, index: 1 }]);
  assert.deepEqual(result.issues.duplicateNames, [{ name: "link: Open", count: 2 }]);
  assert.deepEqual(result.topStructures[0], { role: "main", name: null, descendantNodes: 5 });
});
