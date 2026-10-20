import assert from "node:assert/strict";
import test from "node:test";
import { connections, connectorLayers, ecosystemLayout, nodeStyle, organizations, repositories, routes } from "../../docs/lib/workflow-ecosystem.mjs";
import { safeOutputPaths } from "../../docs/components/workflow-illustration-icons.mjs";

const nodes = ecosystemLayout.children;
const edges = ecosystemLayout.edges.filter((edge) => !edge.id.startsWith("scope-"));
const epsilon = 0.000001;

test("repository workflows illustrate their own discussion, pull request, and issue safe outputs", () => {
  assert.deepEqual(new Set(repositories.map((repository) => repository.output)), new Set(["discussion", "pull request", "issue"]));
  for (const repository of repositories) assert.ok(safeOutputPaths[repository.output]?.length);
});

test("workflow ecosystem expands from enterprise to three organizations and four repositories", () => {
  assert.deepEqual(organizations.map((organization) => organization.name), ["Org 1", "Org 2", "Org N"]);
  assert.deepEqual(repositories.map((repository) => repository.name), ["Repo 1", "Repo 2", "Repo 3", "Repo N"]);
  const enterprise = nodes.find((node) => node.id === "enterprise");
  const organizationNodes = organizations.map(({ id }) => nodes.find((node) => node.id === id));
  const repositoryNodes = repositories.map(({ id }) => nodes.find((node) => node.id === id));
  assert.equal(new Set(organizationNodes.map((node) => node.y)).size, 1);
  assert.equal(new Set(repositoryNodes.map((node) => node.y)).size, 1);
  assert.ok(enterprise.y + enterprise.height < organizationNodes[0].y);
  assert.ok(organizationNodes[0].y + organizationNodes[0].height < repositoryNodes[0].y);
  assert.ok(repositoryNodes.at(-1).x + repositoryNodes.at(-1).width - repositoryNodes[0].x
    > organizationNodes.at(-1).x + organizationNodes.at(-1).width - organizationNodes[0].x);
  assert.equal(edges.length, 7);
  assert.equal(routes.length, 12);
});

test("connectors and delivery pulses follow enterprise, organization, repository hierarchy", () => {
  assert.deepEqual(connections.map(({ source, target }) => [source, target]), [
    ["enterprise", "org-1"], ["enterprise", "org-2"], ["enterprise", "org-n"],
    ["org-1", "repo-1"], ["org-1", "repo-2"], ["org-2", "repo-3"], ["org-n", "repo-n"],
  ]);
  for (const [index, repository] of repositories.entries()) {
    const parent = connections.find((connection) => connection.target === repository.organization);
    const child = connections.find((connection) => connection.target === repository.id);
    assert.equal(routes[index * 3].path, `${parent.path} ${child.path}`);
    assert.equal(routes[index * 3 + 1].path, `${parent.path} ${child.path}`);
    assert.equal(routes[index * 3 + 2].path, child.path);
  }
});

test("parents are centered over their children with evenly spaced organizations", () => {
  const center = (id) => {
    const node = nodes.find((node) => node.id === id);
    return node.x + node.width / 2;
  };
  assert.equal(center("org-2") - center("org-1"), center("org-n") - center("org-2"));
  for (const parent of ["enterprise", ...organizations.map(({ id }) => id)]) {
    const children = connections.filter((connection) => connection.source === parent).map((connection) => center(connection.target));
    assert.equal(center(parent), (Math.min(...children) + Math.max(...children)) / 2);
  }
  for (const { id } of repositories) {
    assert.equal(nodes.find((node) => node.id === id).height, 208);
  }
});

test("painted connector layers merge overlapping collinear spans", () => {
  assert.deepEqual(connectorLayers.map(({ owner }) => owner), ["enterprise", "organization"]);
  const segments = connectorLayers.map((layer) => layer.path.split(" M").map((segment) => {
    const match = segment.replace(/^M/, "").match(/^([\d.]+) ([\d.]+)([HV])([\d.]+)$/);
    assert.ok(match);
    const [, x, y, direction, end] = match;
    return {
      direction,
      coordinate: Number(direction === "H" ? y : x),
      start: Number(direction === "H" ? x : y),
      end: Number(end),
    };
  }));
  assert.deepEqual(segments.map((layer) => layer.length), [4, 6]);
  for (const layer of segments) {
    for (const [index, segment] of layer.entries()) {
      for (const other of layer.slice(index + 1)) {
        if (segment.direction !== other.direction || segment.coordinate !== other.coordinate) continue;
        assert.ok(segment.end < other.start || other.end < segment.start, "collinear spans must not overlap or abut");
      }
    }
  }
});

test("orthogonal ecosystem routes connect exact border ports without crossing cards", () => {
  for (const edge of edges) {
    assert.equal(edge.sections.length, 1);
    const source = nodes.find((node) => node.ports.some((port) => port.id === edge.sources[0]));
    const target = nodes.find((node) => node.ports.some((port) => port.id === edge.targets[0]));
    const section = edge.sections[0];
    assert.equal(section.startPoint.y, source.y + source.height);
    assert.equal(section.endPoint.y, target.y);
    assert.equal(section.startPoint.x, source.x + source.width / 2);
    assert.equal(section.endPoint.x, target.x + target.width / 2);
    for (const bend of section.bendPoints ?? []) {
      assert.equal(bend.y, (section.startPoint.y + section.endPoint.y) / 2);
    }
    const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
    for (const [index, start] of points.slice(0, -1).entries()) {
      const end = points[index + 1];
      const horizontal = Math.abs(start.y - end.y) < epsilon;
      assert.ok(horizontal || Math.abs(start.x - end.x) < epsilon, `${edge.id} must be orthogonal`);
      for (const point of [start, end]) {
        assert.ok(point.x >= 0 && point.x <= ecosystemLayout.width);
        assert.ok(point.y >= 0 && point.y <= ecosystemLayout.height);
      }
      for (const node of nodes) {
        const crosses = horizontal
          ? start.y > node.y + epsilon && start.y < node.y + node.height - epsilon
            && Math.max(start.x, end.x) > node.x + epsilon && Math.min(start.x, end.x) < node.x + node.width - epsilon
          : start.x > node.x + epsilon && start.x < node.x + node.width - epsilon
            && Math.max(start.y, end.y) > node.y + epsilon && Math.min(start.y, end.y) < node.y + node.height - epsilon;
        assert.ok(!crosses, `${edge.id} crosses ${node.id}`);
      }
    }
  }
});

test("cards and row-centered continuation markers share ELK coordinates", () => {
  for (const node of nodes.filter((node) => !node.id.startsWith("more-"))) {
    assert.ok(nodeStyle(node.id).includes(`--node-x:${node.x / ecosystemLayout.width * 100}%`));
    assert.ok(nodeStyle(node.id).includes(`--node-y:${node.y}px`));
    assert.ok(nodeStyle(node.id).includes(`--node-height:${node.height}px`));
  }
  for (const [marker, peerId] of [["more-orgs", "org-1"], ["more-repos", "repo-1"]]) {
    const peer = nodes.find((node) => node.id === peerId);
    assert.ok(nodeStyle(marker).includes(`--node-y:${peer.y + (peer.height - 24) / 2}px`));
  }
  assert.throws(() => nodeStyle("unknown"), /Missing workflow ecosystem node geometry/);
});
