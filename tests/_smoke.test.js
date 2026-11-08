import { describe, it, expect } from 'vitest';
import { api } from './shim.js';

describe('加载垫片', () => {
  it('能取到被测函数并重置状态', () => {
    expect(typeof api.splitCents).toBe('function');
    expect(typeof api.Ledger.txn).toBe('function');
    expect(['vm', 'esm']).toContain(api.mode);
    const s = api.resetState();
    expect(s.scores.vitality).toBe(0);
    expect(Array.isArray(s.tasks)).toBe(true);
  });
});
