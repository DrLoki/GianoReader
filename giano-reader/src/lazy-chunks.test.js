import { describe, it, expect } from 'vitest';
import { createChunkQueue } from './lazy-chunks.js';

const tick = () => new Promise(r => setTimeout(r, 0));

describe('createChunkQueue', () => {
  it('translates chunks one at a time, most recently queued first', async () => {
    const order = [];
    let active = 0, maxActive = 0;
    const q = createChunkQueue(async (c) => {
      active++; maxActive = Math.max(maxActive, active);
      order.push(c);
      await tick();
      active--;
    });
    q.push(1); // starts immediately
    q.push(2);
    q.push(5); // seen last: goes before 2
    await tick(); await tick(); await tick(); await tick();
    expect(order).toEqual([1, 5, 2]);
    expect(maxActive).toBe(1);
  });

  it('ignores duplicates and chunks marked done', async () => {
    const order = [];
    const q = createChunkQueue(async (c) => { order.push(c); });
    q.markDone(3);
    q.push(3);
    q.push(4);
    q.push(4);
    await tick();
    expect(order).toEqual([4]);
  });

  it('stops when the signal is aborted', async () => {
    const order = [];
    const signal = { aborted: false };
    const q = createChunkQueue(async (c) => { order.push(c); signal.aborted = true; await tick(); }, signal);
    q.push(1);
    q.push(2);
    await tick(); await tick();
    expect(order).toEqual([1]);
  });
});
