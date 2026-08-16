import { describe, expect, it } from 'vitest';
import {
  communicationDoNotCallSchema,
  communicationLeadSchema,
  communicationRepairJobSchema,
} from '../../src/retell.js';

describe('Retell communications workflow input boundaries', () => {
  it('requires a reviewed ordered repair appointment window and idempotency key', () => {
    expect(
      communicationRepairJobSchema.safeParse({
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
        windowStart: '2026-08-17T09:00:00.000Z',
        windowEnd: '2026-08-17T10:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      communicationRepairJobSchema.safeParse({
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
        windowStart: '2026-08-17T10:00:00.000Z',
        windowEnd: '2026-08-17T09:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('requires meaningful reviewed lead and do-not-call inputs', () => {
    expect(
      communicationLeadSchema.safeParse({
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
      }).success,
    ).toBe(false);
    expect(
      communicationLeadSchema.safeParse({
        idempotencyKey: '11111111-1111-4111-8111-111111111111',
        businessName: 'Example Business',
      }).success,
    ).toBe(true);
    expect(
      communicationDoNotCallSchema.safeParse({ phoneNumber: '123', reason: 'No' }).success,
    ).toBe(false);
  });
});
