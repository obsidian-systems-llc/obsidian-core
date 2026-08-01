import { Client } from 'pg';
import { z } from 'zod';

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

export type Quote = {
  currency: string;
  id: string;
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
type QuoteRow = { currency: string; id: string; total_amount_minor: string };
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

export class PostgresQuoteRepository implements QuoteRepository {
  constructor(private readonly databaseUrl: string) {}

  async createForSubject(
    subject: string,
    input: z.infer<typeof createQuoteSchema>,
  ): Promise<Quote | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const user = await client.query<{ id: string }>(
        `SELECT i.user_id AS id FROM identities i JOIN users u ON u.id = i.user_id
         WHERE i.provider = 'auth0' AND i.provider_subject = $1
           AND u.status = 'active' AND u.archived_at IS NULL`,
        [subject],
      );
      const userId = user.rows[0]?.id;
      if (!userId) {
        await client.query('ROLLBACK');
        return null;
      }
      const previous = await client.query<QuoteRow>(
        'SELECT id, currency, total_amount_minor FROM quotes WHERE created_by_user_id = $1 AND idempotency_key = $2',
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
      const quote = await client.query<{ id: string }>(
        `INSERT INTO quotes
         (customer_profile_id, created_by_user_id, currency, pricing_context, total_amount_minor, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [
          input.customerProfileId ?? null,
          userId,
          currency,
          context,
          totalAmountMinor.toString(),
          input.idempotencyKey,
        ],
      );
      const quoteId = quote.rows[0]!.id;
      for (const line of lines) {
        await client.query(
          `INSERT INTO quote_line_items
           (quote_id, catalog_item_id, catalog_item_version_id, item_key, name, quantity, currency, unit_amount_minor, line_amount_minor)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            quoteId,
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
      await client.query('COMMIT');
      return await this.getQuote(client, {
        currency,
        id: quoteId,
        total_amount_minor: totalAmountMinor.toString(),
      });
    } catch (error) {
      await client.query('ROLLBACK');
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
