import { describe, expect, it, vi } from 'vitest';
import {
  loadResendEmailConfiguration,
  ResendTransactionalEmailProvider,
} from '../../src/customer-email.js';

describe('Resend customer email adapter', () => {
  it('stays disabled without an explicit opt-in and validates enabled configuration', () => {
    expect(loadResendEmailConfiguration({})).toBeNull();
    expect(() => loadResendEmailConfiguration({ CUSTOMER_EMAIL_ENABLED: 'true' })).toThrow(
      'RESEND_API_KEY',
    );
  });

  it('sends through the backend API with a provider idempotency key', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ id: 'email_123' }) });
    const provider = new ResendTransactionalEmailProvider(
      {
        apiKey: 're_test',
        from: 'Obsidian Systems <receipts@updates.obsidian-systems.tech>',
        sendSandbox: false,
      },
      fetcher,
    );
    await expect(
      provider.send({
        to: 'customer@example.test',
        from: 'Obsidian Systems <receipts@updates.obsidian-systems.tech>',
        subject: 'Receipt',
        text: 'Paid',
        html: '<p>Paid</p>',
        idempotencyKey: 'email-1',
      }),
    ).resolves.toEqual({ providerMessageReference: 'email_123' });
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.resend.com/emails',
      expect.objectContaining({
        headers: expect.objectContaining({ 'Idempotency-Key': 'email-1' }),
      }),
    );
  });
});
