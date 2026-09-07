const interactiveRoles = new Set([
  "button",
  "checkbox",
  "combobox",
  "heading",
  "link",
  "menuitem",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
]);

function distribution(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const percentile = (value) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))] ?? 0;
  return {
    minimum: sorted[0] ?? 0,
    maximum: sorted.at(-1) ?? 0,
    mean: sorted.length === 0 ? 0 : Number((sorted.reduce((sum, value) => sum + value, 0) / sorted.length).toFixed(2)),
    median: percentile(0.5),
    p90: percentile(0.9),
    p95: percentile(0.95),
  };
}

function frequencies(values, limit = 30) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name))
    .slice(0, limit);
}

export function summarizeDomTree(nodes, structures) {
  return {
    totalElements: nodes.length,
    depth: distribution(nodes.map(({ depth }) => depth)),
    childElements: distribution(nodes.map(({ childElementCount }) => childElementCount)),
    byTag: frequencies(nodes.map(({ tag }) => tag)),
    byClass: frequencies(nodes.flatMap(({ classes }) => classes)),
    topStructures: [...structures]
      .sort((left, right) => right.descendantElements - left.descendantElements)
      .slice(0, 30),
  };
}

export function summarizeAccessibilityTree(snapshot) {
  const nodes = snapshot.split("\n").flatMap((line) => {
    const match = line.match(/^(\s*)-\s+([^\s:]+)(?:\s+"([^"]*)")?/);
    if (!match || match[2].startsWith("/")) return [];
    return [{
      depth: Math.floor(match[1].length / 2),
      role: match[2],
      name: match[3] ?? "",
      level: Number(line.match(/\[level=(\d+)\]/)?.[1] ?? 0),
    }];
  });
  const unnamedInteractive = nodes
    .filter(({ role, name }) => interactiveRoles.has(role) && name.length === 0)
    .map(({ role, depth }) => ({ role, depth }));
  const duplicateNames = frequencies(
    nodes.filter(({ name }) => name.length > 0).map(({ role, name }) => `${role}: ${name}`),
    Number.POSITIVE_INFINITY,
  ).filter(({ count }) => count > 1).slice(0, 30);
  const headingLevels = nodes.filter(({ role, level }) => role === "heading" && level > 0).map(({ level }) => level);
  const headingLevelJumps = headingLevels.flatMap((level, index) => (
    index > 0 && level > headingLevels[index - 1] + 1
      ? [{ from: headingLevels[index - 1], to: level, index }]
      : []
  ));
  const topStructures = nodes.flatMap((node, index) => {
    let end = index + 1;
    while (end < nodes.length && nodes[end].depth > node.depth) end += 1;
    const descendantNodes = end - index - 1;
    return descendantNodes > 0 ? [{ role: node.role, name: node.name || null, descendantNodes }] : [];
  }).sort((left, right) => right.descendantNodes - left.descendantNodes).slice(0, 30);

  return {
    totalNodes: nodes.length,
    depth: distribution(nodes.map(({ depth }) => depth)),
    byRole: frequencies(nodes.map(({ role }) => role)),
    topStructures,
    issues: {
      unnamedInteractive,
      duplicateNames,
      headingLevelJumps,
    },
  };
}
