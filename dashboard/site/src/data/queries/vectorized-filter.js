import { tidy } from '../../data-operations.js';
import {
  dashboardQueryDefects,
  dashboardQueryIndex,
  executeDashboardQueries
} from './declarative.js';

const MIN_GPU_ROWS = 4096;
const WORKGROUP_SIZE = 64;
const MIN_INT = -2147483648;
const MAX_INT = 2147483647;
// WebGPU's stable buffer-usage and map-mode bit values.
const BUFFER_MAP_READ = 1;
const BUFFER_COPY_SRC = 4;
const BUFFER_COPY_DST = 8;
const BUFFER_STORAGE = 128;

/**
 * Run a numeric equality filter on the GPU when the worker has WebGPU.
 * Unsupported values and unavailable devices retain the ordinary row semantics.
 * @param {Record<string, unknown>[]} rows
 * @param {import('../../data-operations.js').DataOperator} operator
 * @param {AbortSignal | undefined} signal
 * @returns {Promise<Record<string, unknown>[] | null>}
 */
export async function gpuFilter(rows, operator, signal = undefined) {
  if (operator.op !== 'filter' || rows.length < MIN_GPU_ROWS || operator.search?.query
      || operator.predicates?.length !== 1) return null;
  const predicate = operator.predicates[0];
  const target = predicate.equals;
  if (predicate.field === '@time' || predicate.optional || typeof target !== 'number'
      || !Number.isInteger(target)
      || target < MIN_INT || target > MAX_INT
      || predicate.in !== undefined || predicate.includes !== undefined
      || predicate.gte !== undefined || predicate.lt !== undefined) return null;
  const gpu = /** @type {{ gpu?: { requestAdapter: () => Promise<any> } }} */ (globalThis.navigator ?? {}).gpu;
  if (!gpu || typeof gpu.requestAdapter !== 'function') return null;

  const values = new Int32Array(rows.length);
  for (let i = 0; i < rows.length; i += 1) {
    const value = rows[i][predicate.field];
    // `tidy` compares stringified values; only numeric integer columns are
    // eligible, so no coercion, null handling or precision may change.
    if (typeof value !== 'number' || !Number.isInteger(value)
        || value < MIN_INT || value > MAX_INT) return null;
    values[i] = /** @type {number} */ (value);
  }
  if (signal?.aborted) return null;
  /** @type {any} */
  let device;
  let mapped = false;
  try {
    const adapter = await gpu.requestAdapter();
    if (!adapter || signal?.aborted) return null;
    device = await adapter.requestDevice();
    if (signal?.aborted) return null;
    const size = Math.ceil(rows.length / WORKGROUP_SIZE) * WORKGROUP_SIZE * 4;
    const input = device.createBuffer({
      size, usage: BUFFER_STORAGE | BUFFER_COPY_DST
    });
    const output = device.createBuffer({
      size, usage: BUFFER_STORAGE | BUFFER_COPY_SRC
    });
    const readback = device.createBuffer({
      size, usage: BUFFER_COPY_DST | BUFFER_MAP_READ
    });
    try {
      device.queue.writeBuffer(input, 0, values);
      const shader = device.createShaderModule({ code: `
        struct Input { values: array<i32> }
        struct Output { matches: array<u32> }
        @group(0) @binding(0) var<storage, read> input: Input;
        @group(0) @binding(1) var<storage, read_write> output: Output;
        @compute @workgroup_size(${WORKGROUP_SIZE})
        fn main(@builtin(global_invocation_id) id: vec3<u32>) {
          if (id.x < ${rows.length}u) {
            output.matches[id.x] = select(0u, 1u, input.values[id.x] == ${target}i);
          }
        }
      ` });
      const pipeline = device.createComputePipeline({
        layout: 'auto', compute: { module: shader, entryPoint: 'main' }
      });
      const bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: input } },
          { binding: 1, resource: { buffer: output } }
        ]
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(rows.length / WORKGROUP_SIZE));
      pass.end();
      encoder.copyBufferToBuffer(output, 0, readback, 0, size);
      device.queue.submit([encoder.finish()]);
      await readback.mapAsync(BUFFER_MAP_READ);
      mapped = true;
      if (signal?.aborted) return null;
      const mask = new Uint32Array(readback.getMappedRange());
      const selected = rows.filter((_, index) => mask[index] === 1);
      return selected;
    } finally {
      if (mapped) readback.unmap();
      input.destroy();
      output.destroy();
      readback.destroy();
    }
  } catch {
    // Device loss, denied adapters, and unsupported implementations use CPU.
    return null;
  } finally {
    device?.destroy();
  }
}

/**
 * Worker-side operator pipeline. All operators use the existing implementation
 * unless a numeric equality filter can be executed without changing its meaning.
 * @param {Record<string, unknown>[]} rows
 * @param {import('../../data-operations.js').DataOperator[]} operators
 * @param {AbortSignal | undefined} signal
 */
export function tidyVectorized(rows, operators, signal = undefined) {
  if (signal?.aborted) throw signal.reason ?? new Error('Query cancelled');
  if (rows.length < MIN_GPU_ROWS
      || !/** @type {{ gpu?: unknown }} */ (globalThis.navigator ?? {}).gpu) return tidy(rows, operators);
  return (async () => {
    let current = [...rows];
    for (const operator of operators) {
      if (signal?.aborted) throw signal.reason ?? new Error('Query cancelled');
      const filtered = await gpuFilter(current, operator, signal);
      current = filtered ?? tidy(current, [operator]);
    }
    if (signal?.aborted) throw signal.reason ?? new Error('Query cancelled');
    return current;
  })();
}

/**
 * Accelerate a standalone declarative query's filter before its remaining
 * operators. Queries with joins, unions, dependencies, or pagination retain
 * the regular lazy engine so their budgets and source graphs stay unchanged.
 * @param {unknown} definitions
 * @param {Record<string, import('../../presenter.js').LogicalSourceInput>} sources
 * @param {Iterable<string> | undefined} requested
 * @param {Parameters<typeof executeDashboardQueries>[3]} options
 */
export async function executeVectorizedDashboardQueries(definitions, sources, requested, options = {}) {
  if (!Array.isArray(definitions)) {
    return executeDashboardQueries(definitions, sources, requested, options);
  }
  const index = dashboardQueryIndex(definitions);
  const names = requested === undefined ? [...index.keys()] : [...requested];
  const definition = names.length === 1 ? index.get(names[0]) : undefined;
  const input = definition && sources[definition.from];
  if (!definition?.filter || definition.joins?.length || definition.union?.length
      || index.has(definition.from) || dashboardQueryDefects(definitions).has(definition.name)
      || input?.metadata?.availability === 'unavailable'
      || options.pagination?.[definition.name]
      || options.budget || options.maxOperations !== undefined || options.timeout !== undefined
      || !Array.isArray(input?.rows) || input.rows.length > 200000) {
    return executeDashboardQueries(definitions, sources, requested, options);
  }
  const rows = await gpuFilter(input.rows, { op: 'filter', ...definition.filter });
  if (rows === null || options.signal?.aborted) {
    return executeDashboardQueries(definitions, sources, requested, options);
  }
  const query = { ...definition };
  delete query.filter;
  return executeDashboardQueries(
    definitions.map((candidate) => candidate === definition ? query : candidate),
    { ...sources, [definition.from]: { ...input, rows } },
    requested,
    options
  );
}
