import { afterEach, describe, expect, it, vi } from 'vitest';
import { tidy } from '../../src/data-operations.js';
import { tidyVectorized } from '../../src/data/queries/vectorized-filter.js';

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
    await expect(tidyVectorized(rows, [filter], controller.signal)).rejects.toThrow();
  });
});
