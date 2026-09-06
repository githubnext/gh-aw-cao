import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const approvedWidths = new Set([1200]);
const visualKinds = new Map([
  ["chart", "data-series"],
  ["diagram", "data-node"],
  ["infographic", "data-claim"],
]);
const stateColors = {
  light: {
    open: "#1a7f37",
    closed: "#cf222e",
    merged: "#8250df",
    draft: "#57606a",
    "in-progress": "#9a6700",
    done: "#1a7f37",
    success: "#1a7f37",
    skipped: "#57606a",
    danger: "#cf222e",
    error: "#cf222e",
  },
  dark: {
    open: "#3fb950",
    closed: "#f85149",
    merged: "#a371f7",
    draft: "#8b949e",
    "in-progress": "#e3b341",
    done: "#3fb950",
    success: "#3fb950",
    skipped: "#8b949e",
    danger: "#f85149",
    error: "#f85149",
  },
};

function findSvgFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return findSvgFiles(entryPath);
    return entry.isFile() && entry.name.endsWith(".svg") ? [entryPath] : [];
  });
}

function selectedFiles() {
  if (!process.env.SVG_FILES) {
    return [
      ...findSvgFiles(path.join(root, "docs", "assets")),
      ...findSvgFiles(path.join(root, "public", "assets")),
    ];
  }

  const requested = process.env.SVG_FILES.split(/[\s\r\n]+/).filter(Boolean);
  const missing = requested.filter((file) => !fs.existsSync(path.resolve(root, file)));
  if (missing.length > 0) {
    throw new Error(`Requested SVG files do not exist: ${missing.join(", ")}`);
  }
  return requested.map((file) => path.resolve(root, file));
}

function attribute(source, name) {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(source);
  return match ? match[1] ?? match[2] : null;
}

function stripTags(source) {
  return source.replace(/<[^>]*>/g, "").trim();
}

function referencedText(svg, id) {
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(
    `<([\\w:-]+)\\b[^>]*\\bid\\s*=\\s*(?:"${escapedId}"|'${escapedId}')[^>]*>([\\s\\S]*?)<\\/\\1\\s*>`,
    "i",
  ).exec(svg);
  return match ? stripTags(match[2]) : "";
}

function numericAttribute(source, name, fallback = null) {
  const value = attribute(source, name);
  if (value === null) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function elementAttributeSources(source, elementName) {
  const starts = source.matchAll(new RegExp(`<${elementName}\\b`, "gi"));
  return [...starts].flatMap((match) => {
    let quote = null;
    for (let index = match.index + match[0].length; index < source.length; index += 1) {
      const character = source[index];
      if (quote !== null) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") {
        quote = character;
      } else if (character === ">") {
        return [source.slice(match.index + match[0].length, index)];
      }
    }
    return [];
  });
}

function nestedBoxViolations(svg, rootAttributes) {
  const viewBox = (attribute(rootAttributes, "viewBox") || "")
    .trim()
    .split(/\s+/)
    .map(Number);
  const hasValidViewBox = viewBox.length === 4 && viewBox.every(Number.isFinite);
  const [viewX = 0, viewY = 0, viewWidth = 0, viewHeight = 0] = hasValidViewBox ? viewBox : [];
  const rectangles = elementAttributeSources(svg, "rect")
    .map((attributes, index) => ({
      index: index + 1,
      x: numericAttribute(attributes, "x", 0),
      y: numericAttribute(attributes, "y", 0),
      width: numericAttribute(attributes, "width"),
      height: numericAttribute(attributes, "height"),
    }))
    .filter(({ x, y, width, height }) =>
      x !== null && y !== null && width !== null && height !== null && width > 0 && height > 0)
    .filter(({ x, y, width, height }) => {
      if (!hasValidViewBox || viewWidth <= 0 || viewHeight <= 0) return true;
      const marginX = viewWidth * 0.02;
      const marginY = viewHeight * 0.02;
      return !(
        x <= viewX + marginX
        && y <= viewY + marginY
        && x + width >= viewX + viewWidth - marginX
        && y + height >= viewY + viewHeight - marginY
      );
    });

  const violations = [];
  for (const outer of rectangles) {
    for (const inner of rectangles) {
      if (outer === inner) continue;
      const contained = inner.x >= outer.x
        && inner.y >= outer.y
        && inner.x + inner.width <= outer.x + outer.width
        && inner.y + inner.height <= outer.y + outer.height;
      const strictlyContained = contained && (
        inner.x > outer.x
        || inner.y > outer.y
        || inner.x + inner.width < outer.x + outer.width
        || inner.y + inner.height < outer.y + outer.height
      );
      if (strictlyContained) {
        violations.push(`Box <rect> #${inner.index} is nested inside box <rect> #${outer.index}; boxes must be top-level.`);
      }
    }
  }
  return violations;
}

function checkSvg(svgPath) {
  const relativePath = path.relative(root, svgPath);
  const svg = fs.readFileSync(svgPath, "utf8");
  const violations = [];
  const rootMatch = /<svg\b([^>]*)>/i.exec(svg);
  if (!rootMatch) return ["No root <svg> element found."];

  const rootAttributes = rootMatch[1];
  const visualKind = (attribute(rootAttributes, "data-visual-kind") || "").toLowerCase();
  const visualId = attribute(rootAttributes, "data-visual-id") || "";
  const isThemeVariant = /-(light|dark)\.svg$/i.test(relativePath);
  const requiresContract = Boolean(visualKind || visualId || isThemeVariant);
  if (!requiresContract) return violations;

  violations.push(...nestedBoxViolations(svg, rootAttributes));

  if ((attribute(rootAttributes, "role") || "").toLowerCase() !== "img") {
    violations.push('Missing role="img" on the root <svg>.');
  }

  const ariaLabel = attribute(rootAttributes, "aria-label")?.trim();
  const labelledBy = attribute(rootAttributes, "aria-labelledby")?.trim();
  if (!ariaLabel && !labelledBy) {
    violations.push("Missing a non-empty accessible name.");
  } else if (!ariaLabel && labelledBy) {
    const unresolved = labelledBy.split(/\s+/).filter((id) => !referencedText(svg, id));
    if (unresolved.length > 0) {
      violations.push(`aria-labelledby references missing or empty elements: ${unresolved.join(", ")}.`);
    }
  }

  if (!visualKinds.has(visualKind)) {
    violations.push('data-visual-kind must be "chart", "diagram", or "infographic".');
  } else {
    if (!visualId) violations.push("Missing a stable data-visual-id.");
    const childAttribute = visualKinds.get(visualKind);
    if (!new RegExp(`\\b${childAttribute}\\s*=`, "i").test(svg)) {
      violations.push(`Declared ${visualKind} has no ${childAttribute} attributes.`);
    }
    if (visualKind !== "infographic" && /<(?:linearGradient|radialGradient)\b/i.test(svg)) {
      violations.push(`Declared ${visualKind} uses a gradient.`);
    }
  }

  if (isThemeVariant) {
    const viewBox = attribute(rootAttributes, "viewBox") || "";
    const dimensions = /^0(?:\.0+)?\s+0(?:\.0+)?\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)$/.exec(viewBox);
    if (!dimensions) {
      violations.push(`Theme variant has an invalid viewBox: ${viewBox || "missing"}.`);
    } else if (!approvedWidths.has(Number(dimensions[1]))) {
      violations.push(`Theme variant uses unsupported canvas width ${dimensions[1]}.`);
    }

    const counterpart = svgPath.replace(/-(light|dark)(\.svg)$/i, (_, theme, extension) =>
      `-${theme.toLowerCase() === "light" ? "dark" : "light"}${extension}`);
    if (!fs.existsSync(counterpart)) violations.push(`Missing theme counterpart ${path.basename(counterpart)}.`);

    const theme = /-dark\.svg$/i.test(relativePath) ? "dark" : "light";
    for (const match of svg.matchAll(/<(?:rect|circle|ellipse|path|polygon)\b([^>]*)>/gi)) {
      const state = attribute(match[1], "data-state")?.toLowerCase();
      if (!state) continue;
      const expected = stateColors[theme][state];
      const fill = attribute(match[1], "fill")?.toLowerCase();
      if (!expected) violations.push(`Unknown data-state ${JSON.stringify(state)}.`);
      else if (fill !== expected) violations.push(`data-state ${JSON.stringify(state)} must use ${expected} in ${theme} mode.`);
    }
  }

  for (const match of svg.matchAll(/<(?:text|tspan)\b([^>]*)>([\s\S]*?)<\/(?:text|tspan)>/gi)) {
    const text = stripTags(match[2]);
    const fontSize = Number.parseFloat(attribute(match[1], "font-size") || "0");
    if (text && fontSize > 0 && fontSize < 16) {
      violations.push(`Text ${JSON.stringify(text)} uses font-size ${fontSize}; diagram labels require at least 16px.`);
    }
    if (text.length <= 20 && /[✓✔✗✕✘⚡⏰▶►]/u.test(text)) {
      violations.push(`Text ${JSON.stringify(text)} uses a Unicode icon instead of a Primer Octicon.`);
    }
  }

  return violations;
}

let files;
try {
  files = selectedFiles();
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
}

let violationCount = 0;
for (const svgPath of files) {
  const violations = checkSvg(svgPath);
  if (violations.length === 0) continue;
  violationCount += violations.length;
  process.stderr.write(`\n${path.relative(root, svgPath)}\n`);
  for (const violation of violations) process.stderr.write(`  - ${violation}\n`);
}

if (violationCount > 0) {
  process.stderr.write(`\n${violationCount} SVG visual-language violation(s) found.\n`);
  process.exit(1);
}

process.stdout.write(`${files.length} SVG file(s) checked; no visual-language violations found.\n`);