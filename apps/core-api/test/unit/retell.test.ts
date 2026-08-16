import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyRetellWebhook } from '../../src/retell.js';

describe('Retell webhook signature verification', () => {
  it('accepts only a current HMAC over the exact raw body and timestamp', () => {
    const now = 1_700_000_000_000;
    const payload = '{"event":"call_started"}';
    const signature = `v=${now},d=${createHmac('sha256', 'test-key')
      .update(payload + now)
      .digest('hex')}`;
    expect(verifyRetellWebhook({ apiKey: 'test-key', payload, signature, now })).toBe(true);
    expect(verifyRetellWebhook({ apiKey: 'test-key', payload: '{}', signature, now })).toBe(false);
    expect(
      verifyRetellWebhook({ apiKey: 'test-key', payload, signature, now: now + 300_001 }),
    ).toBe(false);
  });
});
