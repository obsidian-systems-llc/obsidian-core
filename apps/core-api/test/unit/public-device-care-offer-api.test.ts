import { afterAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

const availableApp = buildApp({
  publicDeviceCareOfferRepository: {
    getActiveOffer: async () => ({
      plan: {
        amountMinor: '1500',
        cadence: 'monthly',
        currency: 'USD',
        effectiveFrom: new Date('2026-08-23T00:00:00.000Z'),
        key: 'device-care',
        name: 'Obsidian Device Care',
      },
      repairCredits: { accrualMinor: '1500', capMinor: '35000', unlockMinor: '6000' },
    }),
  },
});
const unavailableApp = buildApp({
  publicDeviceCareOfferRepository: { getActiveOffer: async () => null },
});

afterAll(async () => {
  await availableApp.close();
  await unavailableApp.close();
});

describe('public Device Care offer API', () => {
  it('returns only Core-owned current enrollment terms without authentication', async () => {
    const response = await availableApp.inject({
      method: 'GET',
      url: '/v1/public/device-care/offer',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      plan: {
        amountMinor: '1500',
        cadence: 'monthly',
        currency: 'USD',
        effectiveFrom: '2026-08-23T00:00:00.000Z',
        key: 'device-care',
        name: 'Obsidian Device Care',
      },
      repairCredits: { accrualMinor: '1500', capMinor: '35000', unlockMinor: '6000' },
    });
  });

  it('does not advertise enrollment when Core has no active offer', async () => {
    const response = await unavailableApp.inject({
      method: 'GET',
      url: '/v1/public/device-care/offer',
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: 'DEVICE_CARE_OFFER_UNAVAILABLE' } });
  });
});
