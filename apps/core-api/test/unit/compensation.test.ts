import { describe, expect, it } from 'vitest';
import { calculateCommissionMinor, DEFAULT_COMPENSATION } from '../../src/compensation.js';
describe('compensation calculations', () => {
  it('uses integer minor units for the configurable 10% rate and attribution', () => {
    expect(DEFAULT_COMPENSATION.hourlyRateMinor).toBe(2000);
    expect(
      calculateCommissionMinor({
        eligibleRevenueMinor: 10000n,
        commissionRateBasisPoints: 1000,
        attributionBasisPoints: 10000,
      }),
    ).toBe(1000n);
  });
});
