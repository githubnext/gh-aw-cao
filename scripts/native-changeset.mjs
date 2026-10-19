import { createHash } from "node:crypto";

export const revision = "c86377ec47b38f0b5af463277ee55d1d03d08da8";
export const cutoff = "2026-10-18T15:00:12Z";
export const repository = "github/gh-aw";
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
export const gitBlob = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
export const historyStart = "2026-10-04T15:00:12Z";
export const sourceProfile = {
  ".github/workflows/changeset.md": "66950e20545bc3608d6daac3343e6d0e978d4726",
  ".github/workflows/shared/changeset-format.md": "f1c6462e27c4299801059f433826b9ee700508d2",
  "scripts/changeset.js": "ec759136f8caa847db4091a86f6ab9e36815f7ce",
};

// Port only parseChangesetFile, not the release CLI's filesystem/Git side effects.
export function parseNativeChangeset(content) {
  if (typeof content !== "string") throw new Error("Changeset content must be text");
  const lines = content.split("\n");
  if (lines[0] !== "---") return { readable: false, reason: "missing frontmatter" };
  const end = lines.indexOf("---", 1);
  if (end === -1) return { readable: false, reason: "unclosed frontmatter" };
  let bumpType = null;
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^"(githubnext\/)?gh-aw":\s*(patch|minor|major)/);
    if (match) { bumpType = match[2]; break; }
  }
  if (!bumpType) return { readable: false, reason: "missing or invalid gh-aw field" };
  const body = lines.slice(end + 1).join("\n").trim();
  const codemod = body.match(/^([\s\S]*?)(?:^|\n)## Codemod\s*\n([\s\S]*)$/m);
  return { readable: true, package: "gh-aw", bumpType,
    description: codemod ? codemod[1].trim() : body,
    codemod: codemod ? codemod[2].trim() : null };
}

export function decodeBlob(row) {
  if (!row || !["100644", "100755"].includes(row.mode) || typeof row.content !== "string"
    || !/^[a-f0-9]{40}$/.test(row.gitBlob) || !/^[a-f0-9]{64}$/.test(row.sha256)) {
    throw new Error("Invalid raw Git blob envelope");
  }
  const bytes = Buffer.from(row.content, "base64");
  if (bytes.toString("base64") !== row.content || bytes.length !== row.bytes
    || gitBlob(bytes) !== row.gitBlob || sha256(bytes) !== row.sha256
    || !Buffer.from(bytes.toString("utf8")).equals(bytes)) {
    throw new Error("Raw Git blob identity or UTF-8 mismatch");
  }
  return bytes.toString("utf8");
}

export function inspectChangeset(row) {
  if (!/^\.changeset\/[^/]+\.md$/.test(row?.path ?? "")) throw new Error("Out-of-scope changeset");
  const content = decodeBlob(row);
  const parsed = parseNativeChangeset(content);
  const lines = content.split("\n");
  const end = lines.indexOf("---", 1);
  const packageLines = lines.slice(1, end);
  const exactHeader = packageLines.length === 1
    && /^"gh-aw": (patch|minor|major)$/.test(packageLines[0]);
  const filename = row.path.match(/^\.changeset\/(patch|minor|major)-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/);
  return { path: row.path, gitBlob: row.gitBlob, readable: parsed.readable,
    nonemptyDescription: parsed.readable && parsed.description.length > 0,
    specifiedFormat: parsed.readable && exactHeader && Boolean(filename)
      && filename[1] === parsed.bumpType && parsed.description.length > 0,
    bumpType: parsed.bumpType ?? null, reason: parsed.reason ?? null,
    descriptionSha256: parsed.readable ? sha256(parsed.description) : null,
    semanticAccuracy: null, semanticCompleteness: null, bumpAppropriateness: null };
}

export function validatePacket(packet) {
  if (packet?.schemaVersion !== 1 || packet.repository !== repository
    || packet.repositoryId !== 1036865607 || packet.revision !== revision || packet.cutoff !== cutoff
    || !Array.isArray(packet.sources) || !Array.isArray(packet.entries)
    || !Array.isArray(packet.tree) || typeof packet.rawTree !== "string") {
    throw new Error("Invalid changeset evidence scope");
  }
  const treeBytes = Buffer.from(packet.rawTree, "base64");
  if (treeBytes.toString("base64") !== packet.rawTree || sha256(treeBytes) !== packet.treeSha256) {
    throw new Error("Changeset tree digest mismatch");
  }
  const rawRows = treeBytes.toString("utf8").split("\0").filter(Boolean).map(line => {
    const match = line.match(/^(\d{6}) blob ([a-f0-9]{40})\t(.+)$/);
    if (!match) throw new Error("Invalid native tree record");
    return { mode: match[1], gitBlob: match[2], path: match[3] };
  });
  const selected = rawRows.filter(row => /^\.changeset\/[^/]+\.md$/.test(row.path));
  if (JSON.stringify(selected) !== JSON.stringify(packet.tree)
    || packet.entries.length !== selected.length || new Set(selected.map(row => row.path)).size !== selected.length) {
    throw new Error("Changeset inventory mismatch");
  }
  const required = [".github/workflows/changeset.md", ".github/workflows/shared/changeset-format.md",
    "scripts/changeset.js"];
  for (const file of required) {
    const row = packet.sources.find(source => source.path === file);
    if (!row || row.status !== "available") throw new Error(`Missing required frozen rule: ${file}`);
    decodeBlob(row);
    const native = rawRows.find(source => source.path === file);
    if (!native || native.gitBlob !== row.gitBlob || native.mode !== row.mode
      || row.gitBlob !== sourceProfile[file]) throw new Error("Rule tree identity mismatch");
  }
  const results = [], missing = [];
  packet.entries.forEach((row, index) => {
    const expected = selected[index];
    if (row.path !== expected.path || row.gitBlob !== expected.gitBlob || row.mode !== expected.mode) {
      throw new Error("Changeset entry tree identity mismatch");
    }
    if (row.status === "unavailable") {
      if (typeof row.reason !== "string" || !row.reason) throw new Error("Missing explicit source gap");
      missing.push({ path: row.path, gitBlob: row.gitBlob, reason: row.reason });
    } else if (row.status === "available") results.push(inspectChangeset(row));
    else throw new Error("Invalid source availability");
  });
  return { results, missing, total: selected.length,
    populationDigest: sha256(JSON.stringify(selected)),
    readable: results.filter(row => row.readable).length,
    described: results.filter(row => row.nonemptyDescription).length,
    specified: results.filter(row => row.specifiedFormat).length };
}

export function validateTransitions(packet) {
  validatePacket(packet);
  if (!Array.isArray(packet.transitions) || !Array.isArray(packet.commitInventory)
    || packet.historyStart !== historyStart || packet.commitInventory.length !== packet.transitions.length
    || new Set(packet.commitInventory).size !== packet.commitInventory.length) {
    throw new Error("Invalid native transition inventory");
  }
  const profile = ["scripts/changeset.js", ".github/workflows/shared/changeset-format.md"]
    .map(file => packet.sources.find(row => row.path === file).gitBlob);
  const events = [], gaps = [];
  packet.transitions.forEach((transition, index) => {
    if (transition.commit !== packet.commitInventory[index]) throw new Error("Transition inventory identity mismatch");
    const bytes = Buffer.from(transition.rawCommit, "base64");
    const id = createHash("sha1").update(`commit ${bytes.length}\0`).update(bytes).digest("hex");
    if (id !== transition.commit) throw new Error("Native commit identity mismatch");
    const text = bytes.toString("utf8");
    const parent = text.match(/^parent ([a-f0-9]{40})$/m)?.[1];
    const timestamp = text.match(/^committer .+ ([0-9]+) [+-][0-9]{4}$/m)?.[1];
    const at = timestamp ? new Date(Number(timestamp) * 1000).toISOString().replace(".000Z", "Z") : null;
    if (!parent || parent !== transition.parent || at !== transition.at
      || at < historyStart || at >= cutoff) throw new Error("Native transition boundary mismatch");
    const rawDiff = Buffer.from(transition.rawDiff, "base64");
    if (rawDiff.toString("base64") !== transition.rawDiff || sha256(rawDiff) !== transition.diffSha256) {
      throw new Error("Native diff digest mismatch");
    }
    const tokens = rawDiff.toString("utf8").split("\0").filter(Boolean);
    if (tokens.length % 2 !== 0) throw new Error("Invalid native diff tokens");
    const changes = [];
    for (let i = 0; i < tokens.length; i += 2) {
      const match = tokens[i].match(/^:(\d{6}) (\d{6}) ([a-f0-9]{40}) ([a-f0-9]{40}) ([AMD])$/);
      if (!match) throw new Error("Unsupported native diff");
      if (/^\.changeset\/[^/]+\.md$/.test(tokens[i + 1])) changes.push({
        path: tokens[i + 1], beforeMode: match[1], afterMode: match[2],
        beforeId: match[3], afterId: match[4], status: match[5] });
    }
    if (changes.length !== transition.changes.length) throw new Error("Native diff population mismatch");
    const applicable = transition.profileBefore?.every((id, i) => id === profile[i])
      && transition.profileAfter?.every((id, i) => id === profile[i])
      && transition.profileBefore.length === profile.length && transition.profileAfter.length === profile.length;
    changes.forEach((change, i) => {
      const row = transition.changes[i];
      if (row.path !== change.path) throw new Error("Native transition path mismatch");
      const states = ["before", "after"].map(side => {
        const blob = row[side];
        const id = change[`${side}Id`], mode = change[`${side}Mode`];
        if (id === "0".repeat(40)) {
          if (blob !== null || mode !== "000000") throw new Error("False native absence");
          return { readable: false, nonemptyDescription: false, specifiedFormat: false };
        }
        if (!blob || blob.gitBlob !== id || blob.path !== row.path || blob.mode !== mode) {
          throw new Error("Native transition blob mismatch");
        }
        if (blob.status === "unavailable") return null;
        return inspectChangeset(blob);
      });
      if (!applicable || states.some(state => state === null)) {
        gaps.push({ commit: transition.commit, path: row.path, at,
          reason: !applicable ? "Contemporaneous parser/format profile not established unchanged." : "Missing immutable before/after content." });
        return;
      }
      const [before, after] = states;
      events.push({ id: `${transition.commit}:${row.path}`, commit: transition.commit,
        parent, path: row.path, at,
        readable: Number(after.readable) - Number(before.readable),
        described: Number(after.nonemptyDescription) - Number(before.nonemptyDescription),
        specified: Number(after.specifiedFormat) - Number(before.specifiedFormat),
        additions: Number(after.readable && !before.readable),
        describedAdditions: Number(after.nonemptyDescription && !before.nonemptyDescription),
        specifiedAdditions: Number(after.specifiedFormat && !before.specifiedFormat),
        before, after, attribution: "unknown" });
    });
  });
  return { events, gaps };
}
