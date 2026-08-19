import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { z } from 'zod';

const senderSchema = z.string().trim().min(3).max(320);
export type ResendEmailConfiguration = {
  apiKey: string;
  from: string;
  replyTo?: string;
  sendSandbox: boolean;
};
export type TransactionalEmailProvider = {
  send(input: {
    to: string;
    from: string;
    replyTo?: string;
    subject: string;
    html: string;
    text: string;
    idempotencyKey: string;
  }): Promise<{ providerMessageReference: string }>;
};

export function loadResendEmailConfiguration(source: NodeJS.ProcessEnv = process.env) {
  const enabled = source.CUSTOMER_EMAIL_ENABLED === 'true';
  if (!enabled) return null;
  const apiKey = source.RESEND_API_KEY?.trim();
  const from = source.RESEND_FROM_EMAIL?.trim();
  if (!apiKey || !from || !senderSchema.safeParse(from).success)
    throw new Error(
      'RESEND_API_KEY and RESEND_FROM_EMAIL are required when CUSTOMER_EMAIL_ENABLED=true.',
    );
  const replyTo = source.RESEND_REPLY_TO?.trim();
  if (replyTo && !z.string().email().safeParse(replyTo).success)
    throw new Error('RESEND_REPLY_TO must be an email address when configured.');
  return {
    apiKey,
    from,
    ...(replyTo ? { replyTo } : {}),
    sendSandbox: source.CUSTOMER_EMAIL_SEND_SANDBOX === 'true',
  } satisfies ResendEmailConfiguration;
}

export class ResendTransactionalEmailProvider implements TransactionalEmailProvider {
  constructor(
    private readonly configuration: ResendEmailConfiguration,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async send(input: {
    to: string;
    from: string;
    replyTo?: string;
    subject: string;
    html: string;
    text: string;
    idempotencyKey: string;
  }) {
    const response = await this.fetcher('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.configuration.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': input.idempotencyKey,
      },
      body: JSON.stringify({
        from: input.from,
        to: [input.to],
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
    });
    const body = (await response.json().catch(() => ({}))) as { id?: unknown; name?: unknown };
    if (!response.ok || typeof body.id !== 'string')
      throw new EmailProviderError(
        typeof body.name === 'string' ? body.name : 'RESEND_DELIVERY_REJECTED',
      );
    return { providerMessageReference: body.id };
  }
}
export class EmailProviderError extends Error {
  constructor(readonly code: string) {
    super('Transactional email provider did not accept delivery.');
  }
}

export async function queueCustomerProfileUpdatedEmail(
  client: Client,
  input: {
    customerProfileId: string;
    recipientUserId: string;
    eventKey: string;
    changedFieldNames: string[];
  },
) {
  await client.query(
    `INSERT INTO customer_email_deliveries
       (customer_profile_id,recipient_user_id,recipient_email,event_type,event_key,environment,template_data)
     SELECT $1,$2,u.email,'profile_updated',$3,'production',$4::jsonb
     FROM users u WHERE u.id=$2 AND u.status='active'
     ON CONFLICT (event_type,event_key) DO NOTHING`,
    [
      input.customerProfileId,
      input.recipientUserId,
      input.eventKey,
      JSON.stringify({ changedFieldNames: input.changedFieldNames }),
    ],
  );
}

export async function queueDeviceCarePaymentReceipt(
  client: Client,
  input: {
    providerEventReference: string;
    providerInvoiceReference: string;
    providerSubscriptionReference: string;
    environment: 'sandbox' | 'production';
    paidAt: string;
  },
) {
  await client.query(
    `INSERT INTO customer_email_deliveries
       (customer_profile_id,recipient_user_id,recipient_email,event_type,event_key,environment,template_data)
     SELECT cs.customer_profile_id,
       COALESCE(billing.id,fallback.id),
       COALESCE(billing.email,fallback.email),
       'device_care_payment_receipt',$1,$2,
       $3::jsonb
     FROM customer_subscriptions cs
     JOIN subscription_plan_versions spv ON spv.id=cs.subscription_plan_version_id
     LEFT JOIN users billing ON billing.id=cs.billing_user_id AND billing.status='active'
     JOIN LATERAL (
       SELECT u.id,u.email FROM customer_profile_memberships cpm
       JOIN users u ON u.id=cpm.user_id
       WHERE cpm.customer_profile_id=cs.customer_profile_id AND u.status='active'
       ORDER BY cpm.created_at LIMIT 1
     ) fallback ON true
     WHERE cs.provider='square' AND cs.provider_subscription_reference=$4
       AND cs.status IN ('active','past_due','grace') AND cs.provider_environment=$2
     ON CONFLICT (event_type,event_key) DO NOTHING`,
    [
      `${input.providerEventReference}:${input.providerInvoiceReference}`,
      input.environment,
      JSON.stringify({
        subscriptionName: 'Obsidian Device Care',
        amountMinor: null,
        currency: null,
        providerInvoiceReference: input.providerInvoiceReference,
        paidAt: input.paidAt,
      }),
      input.providerSubscriptionReference,
    ],
  );
  await client.query(
    `UPDATE customer_email_deliveries ced SET template_data=jsonb_build_object(
       'subscriptionName',spv.name,
       'amountMinor',spv.amount_minor::text,
       'currency',spv.currency,
       'providerInvoiceReference',ced.template_data->>'providerInvoiceReference',
       'paidAt',ced.template_data->>'paidAt')
     FROM customer_subscriptions cs JOIN subscription_plan_versions spv ON spv.id=cs.subscription_plan_version_id
     WHERE ced.event_type='device_care_payment_receipt'
       AND ced.event_key=$1 AND cs.customer_profile_id=ced.customer_profile_id
       AND cs.provider_subscription_reference=$2`,
    [
      `${input.providerEventReference}:${input.providerInvoiceReference}`,
      input.providerSubscriptionReference,
    ],
  );
}

type DeliveryRow = {
  id: string;
  recipient_email: string;
  event_type: 'profile_updated' | 'device_care_payment_receipt';
  template_data: Record<string, unknown>;
};
export class PostgresCustomerEmailOutbox {
  constructor(
    private readonly databaseUrl: string,
    private readonly configuration: ResendEmailConfiguration,
    private readonly provider: TransactionalEmailProvider = new ResendTransactionalEmailProvider(
      configuration,
    ),
  ) {}
  async deliverPending(limit = 20) {
    let delivered = 0;
    for (let index = 0; index < limit; index += 1) {
      const row = await this.claim();
      if (!row) break;
      try {
        const message = renderCustomerEmail(row);
        const sent = await this.provider.send({
          to: row.recipient_email,
          from: this.configuration.from,
          ...(this.configuration.replyTo ? { replyTo: this.configuration.replyTo } : {}),
          ...message,
          idempotencyKey: `obsidian-core-email-${row.id}`,
        });
        await this.finish(row.id, sent.providerMessageReference);
        delivered += 1;
      } catch (error) {
        await this.fail(
          row.id,
          error instanceof EmailProviderError ? error.code : 'EMAIL_DELIVERY_FAILED',
        );
      }
    }
    return delivered;
  }
  private async claim() {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const row = await client.query<DeliveryRow>(
        `WITH next AS (
           SELECT id FROM customer_email_deliveries
           WHERE (status IN ('queued','failed') OR (status='sending' AND updated_at<=now() - interval '10 minutes')) AND attempts<5
             AND (next_attempt_at IS NULL OR next_attempt_at<=now())
             AND (environment='production' OR $1::boolean)
           ORDER BY queued_at FOR UPDATE SKIP LOCKED LIMIT 1
         ) UPDATE customer_email_deliveries ced SET status='sending',attempts=attempts+1,updated_at=now()
         FROM next WHERE ced.id=next.id
         RETURNING ced.id,ced.recipient_email,ced.event_type,ced.template_data`,
        [this.configuration.sendSandbox],
      );
      await client.query('COMMIT');
      return row.rows[0] ?? null;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }
  private async finish(id: string, providerMessageReference: string) {
    await this.update(id, 'sent', providerMessageReference, null, true);
  }
  private async fail(id: string, code: string) {
    await this.update(id, 'failed', null, code.slice(0, 100), false);
  }
  private async update(
    id: string,
    status: 'sent' | 'failed',
    reference: string | null,
    error: string | null,
    sent: boolean,
  ) {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const updated = await client.query<{ customer_profile_id: string }>(
        `UPDATE customer_email_deliveries SET status=$2,provider_message_reference=COALESCE($3,provider_message_reference),
           last_error_code=$4,sent_at=CASE WHEN $5 THEN now() ELSE sent_at END,
           next_attempt_at=CASE WHEN $2='failed' THEN now() + interval '5 minutes' ELSE NULL END,updated_at=now()
         WHERE id=$1 RETURNING customer_profile_id`,
        [id, status, reference, error, sent],
      );
      if (updated.rows[0])
        await client.query(
          `INSERT INTO audit_events (actor_user_id,action,target_type,target_id,correlation_id,after_value)
           VALUES (NULL,$1,'customer_email_delivery',$2,$3,$4)`,
          [
            status === 'sent' ? 'customer.email_delivered' : 'customer.email_delivery_failed',
            id,
            randomUUID(),
            { provider: 'resend', status, ...(error ? { errorCode: error } : {}) },
          ],
        );
      await client.query('COMMIT');
    } catch (failure) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw failure;
    } finally {
      await client.end();
    }
  }
}

function renderCustomerEmail(row: DeliveryRow) {
  if (row.event_type === 'profile_updated')
    return {
      subject: 'Your Obsidian Systems account information was updated',
      text: 'Your Obsidian Systems customer account information was updated. If you did not make this change, contact us immediately.',
      html: '<p>Your Obsidian Systems customer account information was updated.</p><p>If you did not make this change, contact us immediately.</p>',
    };
  const amount = formatMoney(
    String(row.template_data.amountMinor ?? '0'),
    String(row.template_data.currency ?? 'USD'),
  );
  const reference = String(row.template_data.providerInvoiceReference ?? '');
  return {
    subject: 'Obsidian Device Care payment receipt',
    text: `We received your ${amount} payment for Obsidian Device Care. Receipt reference: ${reference}.`,
    html: `<p>We received your <strong>${amount}</strong> payment for Obsidian Device Care.</p><p>Receipt reference: ${escapeHtml(reference)}.</p>`,
  };
}
function formatMoney(amountMinor: string, currency: string) {
  const amount = BigInt(amountMinor);
  const sign = amount < 0n ? '-' : '';
  const absolute = amount < 0n ? -amount : amount;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  return currency === 'USD'
    ? `${sign}$${whole}.${fraction}`
    : `${sign}${whole}.${fraction} ${currency}`;
}
function escapeHtml(value: string) {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );
}
