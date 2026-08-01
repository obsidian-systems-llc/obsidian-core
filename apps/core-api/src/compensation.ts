export function calculateCommissionMinor(input: {
  eligibleRevenueMinor: bigint;
  commissionRateBasisPoints: number;
  attributionBasisPoints: number;
}): bigint {
  return (
    (input.eligibleRevenueMinor *
      BigInt(input.commissionRateBasisPoints) *
      BigInt(input.attributionBasisPoints)) /
    100000000n
  );
}
export const DEFAULT_COMPENSATION = { commissionRateBasisPoints: 1000, hourlyRateMinor: 2000 };
