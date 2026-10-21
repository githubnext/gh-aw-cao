import ELK from "elkjs/lib/elk.bundled.js";

export const organizations = [
  { id: "org-1", name: "Org 1", workflow: "Issue triage", caption: "Triage" },
  { id: "org-2", name: "Org 2", workflow: "Release readiness", caption: "Readiness" },
  { id: "org-n", name: "Org N", workflow: "Organization standards", caption: "Standardize" },
];

export const repositories = [
  { id: "repo-1", name: "Repo 1", organization: "org-1", local: "Daily team status", caption: "Status", output: "discussion" },
  { id: "repo-2", name: "Repo 2", organization: "org-1", local: "Test coverage", caption: "Tests", output: "pull request" },
  { id: "repo-3", name: "Repo 3", organization: "org-2", local: "Release checks", caption: "Checks", output: "issue" },
  { id: "repo-n", name: "Repo N", organization: "org-n", local: "Project health", caption: "Health", output: "issue" },
];

const port = (id, side) => ({ id, width: 0, height: 0, layoutOptions: { "elk.port.side": side } });
const repositoryWidth = 280;
const organizationWidth = 320;
const nodeGap = 40;
const branchWidths = organizations.map((organization) => {
  const count = repositories.filter((repository) => repository.organization === organization.id).length;
  return Math.max(organizationWidth, count * repositoryWidth + (count - 1) * nodeGap);
});
const columnGap = Math.max(...branchWidths.slice(1).map((width, index) => (
  (branchWidths[index] + width) / 2 + nodeGap
)));
const organizationCenters = organizations.map((organization, index) => branchWidths[0] / 2 + index * columnGap);
const centers = new Map(organizations.map((organization, index) => [organization.id, organizationCenters[index]]));
centers.set("enterprise", (organizationCenters[0] + organizationCenters.at(-1)) / 2);
const continuationCenter = (organizationCenters.at(-2) + organizationCenters.at(-1)) / 2;
centers.set("more-orgs", continuationCenter);
centers.set("more-repos", continuationCenter);
for (const organization of organizations) {
  const children = repositories.filter((repository) => repository.organization === organization.id);
  for (const [index, repository] of children.entries()) {
    centers.set(repository.id, centers.get(organization.id) + (index - (children.length - 1) / 2) * (repositoryWidth + nodeGap));
  }
}
const node = (id, width, height, partition, ports) => ({
  id, width, height, ports, x: centers.get(id) - width / 2,
  layoutOptions: { "elk.partitioning.partition": String(partition), "elk.portConstraints": "FIXED_SIDE" },
});

export const ecosystemLayout = await new ELK().layout({
  id: "ecosystem",
  layoutOptions: {
    "elk.algorithm": "layered",
    "elk.direction": "DOWN",
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.partitioning.activate": "true",
    "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
    "elk.layered.nodePlacement.strategy": "INTERACTIVE",
    "elk.layered.spacing.nodeNodeBetweenLayers": "48",
    "elk.layered.spacing.edgeNodeBetweenLayers": "24",
    "elk.layered.spacing.edgeEdgeBetweenLayers": "12",
    "elk.spacing.nodeNode": String(nodeGap),
    "elk.spacing.edgeNode": "20",
    "elk.spacing.edgeEdge": "12",
    "elk.padding": "[top=0,left=24,bottom=0,right=24]",
  },
  children: [
    node("enterprise", 420, 120, 0, [
      port("enterprise-scope", "SOUTH"),
    ]),
    ...organizations.flatMap((organization, index) => [
      ...(index === 2 ? [node("more-orgs", 24, 24, 1, [port("more-orgs-in", "NORTH"), port("more-orgs-out", "SOUTH")])] : []),
      node(organization.id, organizationWidth, 120, 1, [
        port(`${organization.id}-in`, "NORTH"), port(`${organization.id}-out`, "SOUTH"),
      ]),
    ]),
    ...repositories.flatMap((repository, index) => [
      ...(index === 3 ? [node("more-repos", 24, 24, 2, [port("more-repos-in", "NORTH")])] : []),
      node(repository.id, repositoryWidth, 160, 2, [
        port(`${repository.id}-org`, "NORTH"),
      ]),
    ]),
  ],
  edges: [
    ...organizations.map((organization) => ({
      id: `enterprise-${organization.id}`, sources: ["enterprise-scope"], targets: [`${organization.id}-in`],
    })),
    { id: "scope-more-orgs", sources: ["enterprise-scope"], targets: ["more-orgs-in"] },
    { id: "scope-more-repos", sources: ["more-orgs-out"], targets: ["more-repos-in"] },
    ...repositories.map((repository) => ({
      id: `organization-${repository.id}`,
      sources: [`${repository.organization}-out`], targets: [`${repository.id}-org`],
    })),
  ],
});

export function nodeStyle(id) {
  const result = ecosystemLayout.children?.find((node) => node.id === id);
  if (!result || result.x === undefined || result.y === undefined || !result.width || !result.height || !ecosystemLayout.width) {
    throw new Error(`Missing workflow ecosystem node geometry: ${id}`);
  }
  const peerId = id === "more-orgs" ? "org-1" : id === "more-repos" ? "repo-1" : null;
  const peer = peerId ? ecosystemLayout.children.find((node) => node.id === peerId) : result;
  const y = peer.y + (peer.height - result.height) / 2;
  return `--node-x:${result.x / ecosystemLayout.width * 100}%;--node-y:${y}px;--node-width:${result.width / ecosystemLayout.width * 100}%;--node-height:${result.height}px`;
}

export function edgePath(edge) {
  if (!edge.sections?.length) throw new Error(`Missing workflow ecosystem edge geometry: ${edge.id}`);
  return edge.sections.map((section) => [
    `M${section.startPoint.x} ${section.startPoint.y}`,
    ...(section.bendPoints ?? []).map((point) => `L${point.x} ${point.y}`),
    `L${section.endPoint.x} ${section.endPoint.y}`,
  ].join(" ")).join(" ");
}

export const connections = ecosystemLayout.edges
  .filter((edge) => !edge.id.startsWith("scope-"))
  .map((edge) => ({
    id: edge.id,
    path: edgePath(edge),
    owner: edge.id.startsWith("enterprise-") ? "enterprise" : "organization",
    source: ecosystemLayout.children.find((node) => node.ports.some((port) => port.id === edge.sources[0])).id,
    target: ecosystemLayout.children.find((node) => node.ports.some((port) => port.id === edge.targets[0])).id,
  }));

function mergeConnectorSegments(edges) {
  const lines = new Map();
  for (const edge of edges) {
    for (const section of edge.sections) {
      const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
      for (const [index, start] of points.slice(0, -1).entries()) {
        const end = points[index + 1];
        const horizontal = start.y === end.y;
        if (!horizontal && start.x !== end.x) throw new Error(`Non-orthogonal workflow connector: ${edge.id}`);
        const coordinate = horizontal ? start.y : start.x;
        const key = `${horizontal ? "H" : "V"}:${coordinate}`;
        if (!lines.has(key)) lines.set(key, { horizontal, coordinate, intervals: [] });
        const from = horizontal ? start.x : start.y;
        const to = horizontal ? end.x : end.y;
        lines.get(key).intervals.push([Math.min(from, to), Math.max(from, to)]);
      }
    }
  }
  return [...lines.values()].flatMap(({ horizontal, coordinate, intervals }) => {
    const merged = [];
    for (const [start, end] of intervals.toSorted((a, b) => a[0] - b[0])) {
      const previous = merged.at(-1);
      if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
      else merged.push([start, end]);
    }
    return merged.map(([start, end]) => horizontal
      ? `M${start} ${coordinate}H${end}`
      : `M${coordinate} ${start}V${end}`);
  }).join(" ");
}

// Shared ELK edge spans must be merged, not merely painted together: antialiasing still compounds overlaps.
export const connectorLayers = ["enterprise", "organization"].map((owner) => ({
  owner,
  path: mergeConnectorSegments(ecosystemLayout.edges.filter((edge) => edge.id.startsWith(`${owner}-`))),
}));

export const routes = repositories.flatMap((repository) => {
  const enterprise = connections.find((connection) => connection.target === repository.organization);
  const organization = connections.find((connection) => connection.target === repository.id);
  if (!enterprise || !organization) throw new Error(`Missing workflow ecosystem hierarchy: ${repository.id}`);
  // Separate subpaths keep delivery pulses off the organization card between connectors.
  const path = `${enterprise.path} ${organization.path}`;
  return [
    { path, owner: "enterprise", phase: "optimization", times: "0;0.28;0.34;1" },
    { path: organization.path, owner: "organization", phase: "organization", times: "0;0.36;0.42;1" },
  ];
});
