import { EventEmitter } from "node:events";
import { commitInfo, tokenize } from "../lint-rule/native.mjs";
import { makeDefinition, makeCollector, evidenceNative, facets } from "../lint-rule/model.mjs";

const workflow = "eslint-refiner";
const filename = "eslint-factory/src/rules/require-http-response-error-listener.ts";
const before = 'function isErrorListenerCall() { if (callee.property.name !== "on" && callee.property.name !== "once") return false; }';
const after = 'const LISTENER_METHODS = new Set(["on", "once", "addListener"]);\nfunction isErrorListenerCall() { if (!LISTENER_METHODS.has(callee.property.name)) return false; }';
const example = (a, b) => ({ workflow, native: { known: true, before: a, after: b } });
export const definition = makeDefinition(workflow, {
  targetAttained: example(before, after), targetMissed: example(before, before),
  missing: {}, malformed: example(null, after),
});

export function nativeAlias() {
  let deliveries = 0;
  const emitter = new EventEmitter(), sentinel = new Error("independent-owned-control");
  emitter.addListener("error", error => { if (error === sentinel) deliveries++; });
  emitter.emit("error", sentinel);
  const without = new EventEmitter();
  let unhandled = false;
  try { without.emit("error", sentinel); } catch (error) {
    if (error !== sentinel) throw error;
    unhandled = true;
  }
  return EventEmitter.prototype.on === EventEmitter.prototype.addListener && deliveries === 1 && unhandled;
}
function recognizesAlias(source) {
  if (typeof source !== "string") return null;
  const key = token => `${token.kind}:${token.value ?? ""}`;
  const matches = (tokens, pattern) => {
    const expected = tokenize(pattern).map(key);
    return tokens.some((_, index) => expected.every((value, offset) => tokens[index + offset] && key(tokens[index + offset]) === value));
  };
  let tokens;
  try { tokens = tokenize(source); } catch (error) {
    if (error.name !== "SyntaxError") throw error;
    return null;
  }
  const functionIndex = tokens.findIndex((token, i) => token.kind === "function" &&
    tokens[i + 1]?.kind === "name" && tokens[i + 1]?.value === "isErrorListenerCall");
  if (functionIndex < 0) return null;
  const start = tokens.findIndex((token, i) => i > functionIndex && token.kind === "{");
  let depth = 0, end = -1;
  for (let i = start; i < tokens.length && start >= 0; i++) {
    if (tokens[i].kind === "{") depth++;
    if (tokens[i].kind === "}" && --depth === 0) { end = i + 1; break; }
  }
  if (end < 0) return null;
  const body = tokens.slice(start, end);
  if (matches(body, "!LISTENER_METHODS.has(callee.property.name)")) {
    const setIndex = tokens.findIndex((token, i) => token.kind === "name" && token.value === "LISTENER_METHODS" &&
      matches(tokens.slice(i, i + 7), "LISTENER_METHODS = new Set(["));
    if (setIndex < 0) return null;
    const arrayStart = setIndex + 5, strings = [];
    for (let i = arrayStart + 1; i < tokens.length; i++) {
      if (tokens[i].kind === "]") return strings.includes("addListener");
      if (tokens[i].kind === "string") strings.push(tokens[i].value);
      else if (tokens[i].kind !== ",") return null;
    }
    return null;
  }
  if (matches(body, 'callee.property.name !== "on" && callee.property.name !== "once"')) return false;
  return null;
}
export function scoreMetric(id, evidence) {
  const raw = evidenceNative(workflow, evidence);
  if (id !== "observed-partial" || !raw?.known || !nativeAlias()) return null;
  const a = recognizesAlias(raw.before), b = recognizesAlias(raw.after);
  if (a === null || b === null) return null;
  return Number(b) - Number(a);
}
export const collectBatch = makeCollector(workflow, packet => {
  const { transition } = facets[workflow], { parent } = commitInfo(packet, transition);
  const a = packet.text(parent, filename), b = packet.text(transition, filename);
  return { known: a !== null && b !== null, before: a, after: b,
    reason: a === null || b === null ? "Missing original before/after HTTP rule source" : null,
    independentNativeAlias: nativeAlias(),
    realDiagnosticDefectsResolved: null,
    interpretation: "Source-level standard-API compatibility facet, not a demonstrated real-target false-positive resolution or full native workflow coverage" };
});
