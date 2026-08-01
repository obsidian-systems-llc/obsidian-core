import { describe, expect, it } from 'vitest';
import { laborCostMinor, laborToSalesBasisPoints } from '../../src/reporting.js';
describe('operating aggregates', () =>
  it('uses integer minor units and labels zero sales as undefined', () => {
    const v = {
      collectedRevenueMinor: 0n,
      estimatedCommissionsMinor: 1000n,
      estimatedHourlyWagesMinor: 3000n,
      netSalesMinor: 20000n,
    };
    expect(laborCostMinor(v)).toBe(4000n);
    expect(laborToSalesBasisPoints(v)).toBe(2000n);
    expect(laborToSalesBasisPoints({ ...v, netSalesMinor: 0n })).toBeNull();
  }));
