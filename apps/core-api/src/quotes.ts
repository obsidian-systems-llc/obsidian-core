import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { z } from 'zod';
import { createAuditEvent } from './audit.js';

export const createQuoteSchema = z.object({
  customerProfileId: z.uuid().nullable().optional(),
  idempotencyKey: z.uuid(),
  items: z
    .array(
      z.object({
        catalogItemKey: z.string().trim().min(1).max(100),
        quantity: z.int().min(1).max(10000),
      }),
    )
    .min(1)
    .max(100),
});

export const quoteLifecycleSchema = z.object({
  idempotencyKey: z.uuid(),
  reason: z.string().trim().min(1).max(500).optional(),
});

export const quoteAcceptanceSchema = z.object({
  idempotencyKey: z.uuid(),
  termsVersion: z.string().trim().min(1).max(100),
  attested: z.literal(true),
});
export const quoteRevisionSchema = z.object({
  idempotencyKey: z.uuid(),
  reason: z.string().trim().min(3).max(500),
  overrides: z
    .array(z.object({ quoteLineItemId: z.uuid(), unitAmountMinor: z.coerce.bigint().min(0n) }))
    .max(100)
    .default([]),
});

export type Quote = {
  currency: string;
  id: string;
  status: string;
  items: Array<{
    catalogItemKey: string;
    catalogItemVersionId: string;
    lineAmountMinor: string;
    name: string;
    quantity: number;
    unitAmountMinor: string;
  }>;
  totalAmountMinor: string;
};
export type QuoteRepository = {
  createForSubject(
    subject: string,
    input: z.infer<typeof createQuoteSchema>,
    correlationId: string,
  ): Promise<Quote | null>;
  transitionForSubject?(
    subject: string,
    quoteId: string,
    action: 'issued' | 'approved' | 'cancelled' | 'expired',
    input: z.infer<typeof quoteLifecycleSchema>,
    correlationId: string,
  ): Promise<Quote | null>;
  acceptForSubject?(
    subject: string,
    quoteId: string,
    input: z.infer<typeof quoteAcceptanceSchema>,
    correlationId: string,
  ): Promise<Quote | null>;
  reviseForSubject?(
    subject: string,
    quoteId: string,
    input: z.infer<typeof quoteRevisionSchema>,
    correlationId: string,
    allowOverrides: boolean,
  ): Promise<Quote | null>;
};
type CatalogRow = {
  catalog_item_id: string;
  currency: string;
  id: string;
  item_key: string;
  name: string;
  unit_amount_minor: string;
};
type QuoteRow = { currency: string; id: string; status: string; total_amount_minor: string };
type LineRow = {
  catalog_item_version_id: string;
  currency: string;
  item_key: string;
  line_amount_minor: string;
  name: string;
  quantity: number;
  unit_amount_minor: string;
};

export class QuoteInputError extends Error {}
export class QuoteLifecycleError extends Error {
  constructor(readonly code: 'QUOTE_NOT_FOUND' | 'INVALID_QUOTE_LIFECYCLE' | 'QUOTE_EXPIRED') {
    super(code);
  }
}

export class PostgresQuoteRepository implements QuoteRepository {
  constructor(private readonly databaseUrl: string) {}

  async createForSubject(
    subject: string,
    input: z.infer<typeof createQuoteSchema>,
    correlationId: string,
  ): Promise<Quote | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const user = await client.query<{ id: string }>(
        `SELECT i.user_id AS id FROM identities i JOIN users u ON u.id = i.user_id
         WHERE i.provider_subject = $1
           AND u.status = 'active' AND u.archived_at IS NULL`,
        [subject],
      );
      const userId = user.rows[0]?.id;
      if (!userId) {
        await client.query('ROLLBACK');
        return null;
      }
      const previous = await client.query<QuoteRow>(
        'SELECT id, currency, status, total_amount_minor FROM quotes WHERE created_by_user_id = $1 AND idempotency_key = $2',
        [userId, input.idempotencyKey],
      );
      if (previous.rows[0]) {
        await client.query('COMMIT');
        return await this.getQuote(client, previous.rows[0]);
      }
      const lines: Array<CatalogRow & { lineAmountMinor: bigint; quantity: number }> = [];
      for (const item of input.items) {
        const catalog = await client.query<CatalogRow>(
          `SELECT ci.id AS catalog_item_id, ci.key AS item_key, civ.id, civ.name, civ.currency, civ.unit_amount_minor
           FROM catalog_items ci JOIN catalog_item_versions civ ON civ.catalog_item_id = ci.id
           WHERE ci.key = $1 AND ci.deactivated_at IS NULL AND civ.effective_from <= now()
             AND (civ.effective_to IS NULL OR civ.effective_to > now())
           ORDER BY civ.effective_from DESC, civ.version_number DESC LIMIT 1`,
          [item.catalogItemKey],
        );
        const row = catalog.rows[0];
        if (!row)
          throw new QuoteInputError(`No active catalog version exists for ${item.catalogItemKey}.`);
        lines.push({
          ...row,
          lineAmountMinor: BigInt(row.unit_amount_minor) * BigInt(item.quantity),
          quantity: item.quantity,
        });
      }
      const currency = lines[0]!.currency;
      if (lines.some((line) => line.currency !== currency))
        throw new QuoteInputError('All quote items must use the same currency.');
      const totalAmountMinor = lines.reduce((total, line) => total + line.lineAmountMinor, 0n);
      const context = {
        engine: 'catalog-v1',
        items: lines.map((line) => ({ catalogItemKey: line.item_key, quantity: line.quantity })),
      };
      const quoteId = randomUUID();
      const quote = await client.query<{ id: string }>(
        `INSERT INTO quotes
         (id, customer_profile_id, created_by_user_id, currency, pricing_context, total_amount_minor, idempotency_key, root_quote_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $1) RETURNING id`,
        [
          quoteId,
          input.customerProfileId ?? null,
          userId,
          currency,
          context,
          totalAmountMinor.toString(),
          input.idempotencyKey,
        ],
      );
      const createdQuoteId = quote.rows[0]!.id;
      for (const line of lines) {
        await client.query(
          `INSERT INTO quote_line_items
           (quote_id, catalog_item_id, catalog_item_version_id, item_key, name, quantity, currency, unit_amount_minor, line_amount_minor)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            createdQuoteId,
            line.catalog_item_id,
            line.id,
            line.item_key,
            line.name,
            line.quantity,
            line.currency,
            line.unit_amount_minor,
            line.lineAmountMinor.toString(),
          ],
        );
      }
      const audit = createAuditEvent({
        action: 'quote.created',
        actorUserId: userId,
        afterValue: { currency, totalAmountMinor: totalAmountMinor.toString() },
        beforeValue: null,
        correlationId,
        reason: null,
        targetId: createdQuoteId,
        targetType: 'quote',
      });
      await client.query(
        `INSERT INTO audit_events
         (actor_user_id, action, target_type, target_id, correlation_id, reason, before_value, after_value, occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          audit.actorUserId,
          audit.action,
          audit.targetType,
          audit.targetId,
          audit.correlationId,
          audit.reason,
          audit.beforeValue,
          audit.afterValue,
          audit.occurredAt,
        ],
      );
      await client.query('COMMIT');
      return await this.getQuote(client, {
        currency,
        id: createdQuoteId,
        status: 'draft',
        total_amount_minor: totalAmountMinor.toString(),
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  async transitionForSubject(
    subject: string,
    quoteId: string,
    action: 'issued' | 'approved' | 'cancelled' | 'expired',
    input: z.infer<typeof quoteLifecycleSchema>,
    correlationId: string,
  ): Promise<Quote | null> {
    return await this.changeLifecycle(subject, quoteId, action, input, correlationId, false);
  }

  async acceptForSubject(
    subject: string,
    quoteId: string,
    input: z.infer<typeof quoteAcceptanceSchema>,
    correlationId: string,
  ): Promise<Quote | null> {
    return await this.changeLifecycle(
      subject,
      quoteId,
      'accepted',
      { idempotencyKey: input.idempotencyKey },
      correlationId,
      true,
      { channel: 'customer-portal', termsVersion: input.termsVersion },
    );
  }

  async reviseForSubject(
    subject: string,
    quoteId: string,
    input: z.infer<typeof quoteRevisionSchema>,
    correlationId: string,
    allowOverrides: boolean,
  ): Promise<Quote | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const user = await client.query<{ id: string }>(
        `SELECT i.user_id AS id FROM identities i JOIN users u ON u.id=i.user_id
         WHERE i.provider_subject=$1 AND u.status='active' AND u.archived_at IS NULL`,
        [subject],
      );
      const userId = user.rows[0]?.id;
      if (!userId) {
        await client.query('ROLLBACK');
        return null;
      }
      const duplicate = await client.query<QuoteRow>(
        `SELECT q.id,q.currency,q.status,q.total_amount_minor FROM quote_lifecycle_events e JOIN quotes q ON q.id=e.quote_id
         WHERE e.actor_user_id=$1 AND e.action='revised' AND e.idempotency_key=$2`,
        [userId, input.idempotencyKey],
      );
      if (duplicate.rows[0]) {
        await client.query('COMMIT');
        return this.getQuote(client, duplicate.rows[0]);
      }
      const source = await client.query<
        QuoteRow & {
          customer_profile_id: string | null;
          root_quote_id: string;
          revision_number: number;
          pricing_context: unknown;
          expires_at: Date | null;
        }
      >(
        `SELECT id,currency,status,total_amount_minor,customer_profile_id,root_quote_id,revision_number,pricing_context,expires_at
         FROM quotes WHERE id=$1 FOR UPDATE`,
        [quoteId],
      );
      const quote = source.rows[0];
      if (!quote) throw new QuoteLifecycleError('QUOTE_NOT_FOUND');
      if (!['draft', 'issued', 'approved'].includes(quote.status))
        throw new QuoteLifecycleError('INVALID_QUOTE_LIFECYCLE');
      const lines = await client.query<LineRow & { id: string; catalog_item_id: string }>(
        `SELECT id,catalog_item_id,item_key,catalog_item_version_id,name,quantity,currency,unit_amount_minor,line_amount_minor
         FROM quote_line_items WHERE quote_id=$1 ORDER BY created_at,id FOR UPDATE`,
        [quoteId],
      );
      const overrideByLine = new Map(
        input.overrides.map((item) => [item.quoteLineItemId, item.unitAmountMinor]),
      );
      if (!allowOverrides && overrideByLine.size)
        throw new QuoteLifecycleError('INVALID_QUOTE_LIFECYCLE');
      if ([...overrideByLine.keys()].some((id) => !lines.rows.some((line) => line.id === id)))
        throw new QuoteLifecycleError('INVALID_QUOTE_LIFECYCLE');
      const total = lines.rows.reduce(
        (sum, line) =>
          sum +
          (overrideByLine.get(line.id) ?? BigInt(line.unit_amount_minor)) * BigInt(line.quantity),
        0n,
      );
      const revised = await client.query<{ id: string }>(
        `INSERT INTO quotes (customer_profile_id,created_by_user_id,status,currency,pricing_context,total_amount_minor,idempotency_key,expires_at,root_quote_id,revised_from_quote_id,revision_number)
         VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [
          quote.customer_profile_id,
          userId,
          quote.currency,
          { ...(quote.pricing_context as Record<string, unknown>), revisionReason: input.reason },
          total.toString(),
          input.idempotencyKey,
          quote.expires_at,
          quote.root_quote_id,
          quote.id,
          quote.revision_number + 1,
        ],
      );
      const revisedId = revised.rows[0]!.id;
      for (const line of lines.rows) {
        const unit = overrideByLine.get(line.id) ?? BigInt(line.unit_amount_minor);
        await client.query(
          `INSERT INTO quote_line_items (quote_id,catalog_item_id,catalog_item_version_id,item_key,name,quantity,currency,unit_amount_minor,line_amount_minor)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            revisedId,
            line.catalog_item_id,
            line.catalog_item_version_id,
            line.item_key,
            line.name,
            line.quantity,
            line.currency,
            unit.toString(),
            (unit * BigInt(line.quantity)).toString(),
          ],
        );
      }
      await client.query("UPDATE quotes SET status='superseded',updated_at=now() WHERE id=$1", [
        quote.id,
      ]);
      await client.query(
        `INSERT INTO quote_lifecycle_events (quote_id,actor_user_id,action,reason,evidence,idempotency_key,correlation_id)
        VALUES ($1,$2,'revised',$3,$4,$5,$6),($7,$2,'superseded',$3,$4,$8,$6)`,
        [
          revisedId,
          userId,
          input.reason,
          { revisedFromQuoteId: quote.id, overrideCount: overrideByLine.size },
          input.idempotencyKey,
          correlationId,
          quote.id,
          randomUUID(),
        ],
      );
      if (overrideByLine.size)
        await client.query(
          `INSERT INTO quote_lifecycle_events (quote_id,actor_user_id,action,reason,evidence,idempotency_key,correlation_id)
        VALUES ($1,$2,'price_overridden',$3,$4,$5,$6)`,
          [
            revisedId,
            userId,
            input.reason,
            { overriddenQuoteLineItemIds: [...overrideByLine.keys()] },
            randomUUID(),
            correlationId,
          ],
        );
      const audit = createAuditEvent({
        actorUserId: userId,
        action: overrideByLine.size ? 'quote.revised_with_override' : 'quote.revised',
        targetType: 'quote',
        targetId: revisedId,
        correlationId,
        reason: input.reason,
        beforeValue: { sourceQuoteId: quote.id, status: quote.status },
        afterValue: {
          revisionNumber: quote.revision_number + 1,
          totalAmountMinor: total.toString(),
        },
      });
      await client.query(
        'INSERT INTO audit_events (actor_user_id,action,target_type,target_id,correlation_id,reason,before_value,after_value,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
        [
          audit.actorUserId,
          audit.action,
          audit.targetType,
          audit.targetId,
          audit.correlationId,
          audit.reason,
          audit.beforeValue,
          audit.afterValue,
          audit.occurredAt,
        ],
      );
      await client.query('COMMIT');
      return this.getQuote(client, {
        id: revisedId,
        currency: quote.currency,
        status: 'draft',
        total_amount_minor: total.toString(),
      });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  private async changeLifecycle(
    subject: string,
    quoteId: string,
    action: 'issued' | 'approved' | 'accepted' | 'cancelled' | 'expired',
    input: z.infer<typeof quoteLifecycleSchema>,
    correlationId: string,
    customerOnly: boolean,
    evidence: Record<string, string> = {},
  ): Promise<Quote | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const user = await client.query<{ id: string }>(
        `SELECT i.user_id AS id FROM identities i JOIN users u ON u.id=i.user_id
         WHERE i.provider_subject=$1 AND u.status='active' AND u.archived_at IS NULL`,
        [subject],
      );
      const userId = user.rows[0]?.id;
      if (!userId) {
        await client.query('ROLLBACK');
        return null;
      }
      const existing = await client.query<QuoteRow>(
        `SELECT q.id,q.currency,q.status,q.total_amount_minor FROM quote_lifecycle_events e
         JOIN quotes q ON q.id=e.quote_id WHERE e.actor_user_id=$1 AND e.action=$2 AND e.idempotency_key=$3`,
        [userId, action, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        await client.query('COMMIT');
        return await this.getQuote(client, existing.rows[0]);
      }
      const quote = await client.query<
        QuoteRow & { customer_profile_id: string | null; expires_at: Date | null }
      >(
        'SELECT id,currency,status,total_amount_minor,customer_profile_id,expires_at FROM quotes WHERE id=$1 FOR UPDATE',
        [quoteId],
      );
      const row = quote.rows[0];
      if (!row) throw new QuoteLifecycleError('QUOTE_NOT_FOUND');
      if (customerOnly) {
        const membership = await client.query(
          'SELECT 1 FROM customer_profile_memberships WHERE customer_profile_id=$1 AND user_id=$2',
          [row.customer_profile_id, userId],
        );
        if (!row.customer_profile_id || membership.rowCount !== 1)
          throw new QuoteLifecycleError('QUOTE_NOT_FOUND');
      }
      if (row.expires_at && row.expires_at <= new Date() && action !== 'expired')
        throw new QuoteLifecycleError('QUOTE_EXPIRED');
      const allowed: Record<string, string[]> = {
        issued: ['draft'],
        approved: ['issued'],
        accepted: ['issued', 'approved'],
        cancelled: ['draft', 'issued', 'approved'],
        expired: ['issued', 'approved'],
      };
      if (!allowed[action]?.includes(row.status))
        throw new QuoteLifecycleError('INVALID_QUOTE_LIFECYCLE');
      if (action === 'cancelled' && !input.reason)
        throw new QuoteLifecycleError('INVALID_QUOTE_LIFECYCLE');
      const timestampColumn: Record<string, string> = {
        issued: 'issued_at',
        approved: 'approved_at',
        accepted: 'accepted_at',
        cancelled: 'cancelled_at',
        expired: 'updated_at',
      };
      await client.query(
        `UPDATE quotes SET status=$2, ${timestampColumn[action]}=now(), updated_at=now() WHERE id=$1`,
        [quoteId, action],
      );
      await client.query(
        `INSERT INTO quote_lifecycle_events (quote_id,actor_user_id,action,reason,evidence,idempotency_key,correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          quoteId,
          userId,
          action,
          input.reason ?? null,
          evidence,
          input.idempotencyKey,
          correlationId,
        ],
      );
      const audit = createAuditEvent({
        action: `quote.${action}`,
        actorUserId: userId,
        beforeValue: { status: row.status },
        afterValue: { status: action },
        correlationId,
        reason: input.reason ?? null,
        targetId: quoteId,
        targetType: 'quote',
      });
      await client.query(
        `INSERT INTO audit_events (actor_user_id,action,target_type,target_id,correlation_id,reason,before_value,after_value,occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          audit.actorUserId,
          audit.action,
          audit.targetType,
          audit.targetId,
          audit.correlationId,
          audit.reason,
          audit.beforeValue,
          audit.afterValue,
          audit.occurredAt,
        ],
      );
      await client.query('COMMIT');
      return await this.getQuote(client, { ...row, status: action });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  private async getQuote(client: Client, quote: QuoteRow): Promise<Quote> {
    const lines = await client.query<LineRow>(
      `SELECT item_key, catalog_item_version_id, name, quantity, currency, unit_amount_minor, line_amount_minor
       FROM quote_line_items WHERE quote_id = $1 ORDER BY created_at, id`,
      [quote.id],
    );
    return {
      currency: quote.currency,
      id: quote.id,
      status: quote.status,
      items: lines.rows.map((line) => ({
        catalogItemKey: line.item_key,
        catalogItemVersionId: line.catalog_item_version_id,
        lineAmountMinor: line.line_amount_minor,
        name: line.name,
        quantity: line.quantity,
        unitAmountMinor: line.unit_amount_minor,
      })),
      totalAmountMinor: quote.total_amount_minor,
    };
  }
}
