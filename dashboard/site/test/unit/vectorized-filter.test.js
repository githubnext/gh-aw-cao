import { afterEach, describe, expect, it, vi } from 'vitest';
import { tidy } from '../../src/data-operations.js';
import { executeDashboardQueries } from '../../src/data/queries/declarative.js';
import { executeVectorizedDashboardQueries, gpuFilter, tidyVectorized } from '../../src/data/queries/vectorized-filter.js';

/** @type {import('../../src/data-operations.js').FilterOperator} */
const filter = { op: 'filter', predicates: [{ field: 'score', equals: 3 }] };
const rows = Array.from({ length: 4097 }, (_, index) => ({
  id: index, score: index % 5
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('worker vectorized filters', () => {
  it('uses the ordinary operators when WebGPU is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const operators = /** @type {import('../../src/data-operations.js').DataOperator[]} */ ([
      filter, { op: 'arrange', by: [{ field: 'id', direction: 'desc' }] }
    ]);
    expect(await tidyVectorized(rows, operators)).toEqual(tidy(rows, operators));
  });

  it('uses a GPU mask for eligible numeric equality and preserves row order', async () => {
    const mask = new Uint32Array(Math.ceil(rows.length / 64) * 64);
    const destroy = vi.fn();
    const readback = {
      mapAsync: vi.fn(async () => {}),
      getMappedRange: () => mask.buffer,
      unmap: vi.fn(),
      destroy
    };
    const buffers = [
      { destroy },
      { destroy },
      readback
    ];
    const submit = vi.fn(() => {
      for (let index = 0; index < rows.length; index += 1) {
        mask[index] = rows[index].score === 3 ? 1 : 0;
      }
    });
    const pass = {
      setPipeline: vi.fn(),
      setBindGroup: vi.fn(),
      dispatchWorkgroups: vi.fn(),
      end: vi.fn()
    };
    const device = {
      createBuffer: vi.fn(() => buffers.shift()),
      createShaderModule: vi.fn(() => ({})),
      createComputePipeline: vi.fn(() => ({ getBindGroupLayout: () => ({}) })),
      createBindGroup: vi.fn(() => ({})),
      createCommandEncoder: vi.fn(() => ({
        beginComputePass: () => pass,
        copyBufferToBuffer: vi.fn(),
        finish: () => ({})
      })),
      queue: { writeBuffer: vi.fn(), submit },
      destroy: vi.fn()
    };
    const requestDevice = vi.fn(async () => device);
    vi.stubGlobal('navigator', {
      gpu: { requestAdapter: vi.fn(async () => ({ requestDevice })) }
    });

    expect(await tidyVectorized(rows, [filter])).toEqual(tidy(rows, [filter]));
    expect(device.queue.writeBuffer).toHaveBeenCalledOnce();
    expect(pass.dispatchWorkgroups).toHaveBeenCalledWith(Math.ceil(rows.length / 64));
    expect(readback.unmap).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledTimes(3);
    expect(device.destroy).toHaveBeenCalledOnce();

    buffers.push({ destroy }, { destroy }, readback);
    const definitions = [{ name: 'matching-scores', from: 'scores', filter: { predicates: filter.predicates } }];
    /** @type {Record<string, import('../../src/presenter.js').LogicalSourceInput>} */
    const sources = {
      scores: {
        source: 'scores', rows,
        metadata: {
          'source-id': 'scores', 'source-kind': 'canonical',
          'as-of': '2026-09-01T00:00:00Z', 'retrieved-at': '2026-09-01T00:00:00Z',
          availability: 'available', completeness: 'complete', freshness: 'fresh'
        }
      }
    };
    const accelerated = await executeVectorizedDashboardQueries(definitions, sources, ['matching-scores']);
    const expected = executeDashboardQueries(definitions, sources, ['matching-scores']);
    expect(accelerated['matching-scores'].rows).toEqual(expected['matching-scores'].rows);
    expect(accelerated['matching-scores'].metadata).toEqual(expected['matching-scores'].metadata);
    expect(requestDevice).toHaveBeenCalledTimes(2);
  });

  it('falls back on device errors and on columns requiring string coercion', async () => {
    const requestAdapter = vi.fn(async () => { throw new Error('device unavailable'); });
    vi.stubGlobal('navigator', { gpu: { requestAdapter } });
    expect(await tidyVectorized(rows, [filter])).toEqual(tidy(rows, [filter]));
    const textRows = rows.map((row) => ({ ...row, score: String(row.score) }));
    expect(await tidyVectorized(textRows, [filter])).toEqual(tidy(textRows, [filter]));
    expect(requestAdapter).toHaveBeenCalledOnce();
  });

  it('does not select a GPU result after cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => tidyVectorized(rows, [filter], controller.signal)).toThrow();
  });

  it('stops waiting for a pending adapter when cancelled', async () => {
    vi.stubGlobal('navigator', { gpu: { requestAdapter: () => new Promise(() => {}) } });
    const controller = new AbortController();
    const result = gpuFilter(rows, filter, controller.signal);
    controller.abort();
    expect(await result).toBeNull();
  });

  it('destroys a device that arrives after cancellation', async () => {
    /** @type {(device: { destroy: () => void }) => void} */
    let resolveDevice = () => {};
    const requestedDevice = new Promise((resolve) => { resolveDevice = resolve; });
    /** @type {() => void} */
    let notifyStarted = () => {};
    const started = new Promise((resolve) => { notifyStarted = () => resolve(undefined); });
    vi.stubGlobal('navigator', {
      gpu: { requestAdapter: async () => ({
        requestDevice: () => {
          notifyStarted();
          return requestedDevice;
        }
      }) }
    });
    const controller = new AbortController();
    const result = gpuFilter(rows, filter, controller.signal);
    await started;
    controller.abort();
    expect(await result).toBeNull();
    const destroy = vi.fn();
    resolveDevice({ destroy });
    await Promise.resolve();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
