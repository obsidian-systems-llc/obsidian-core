import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { z } from 'zod';
import { createAuditEvent } from './audit.js';

const benefitTypes = [
  'priority_service',
  'free_diagnostic',
  'device_cleaning',
  'minor_service',
  'screen_protector_installation',
  'loaner_priority',
  'workmanship_warranty',
] as const;

export const deviceCarePageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['active', 'past_due', 'cancelled']).optional(),
});
export const householdMemberSchema = z.object({
  memberCustomerProfileId: z.uuid(),
  relationship: z.enum(['spouse', 'child', 'parent', 'sibling', 'other_immediate_household']),
  idempotencyKey: z.uuid(),
});
export const endHouseholdMemberSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  idempotencyKey: z.uuid(),
});
export const applyRepairCreditSchema = z.object({
  jobId: z.uuid(),
  quoteId: z.uuid(),
  amountMinor: z.coerce.bigint().min(1n),
  reason: z.string().trim().min(3).max(500).optional(),
  idempotencyKey: z.uuid(),
});
export const creditAdjustmentSchema = z.object({
  customerProfileId: z.uuid(),
  entryType: z.enum(['reversal', 'forfeiture', 'restoration']),
  amountMinor: z.coerce.bigint().refine((value) => value !== 0n),
  reason: z.string().trim().min(3).max(500),
  idempotencyKey: z.uuid(),
});
export const benefitRedemptionSchema = z.object({
  customerProfileId: z.uuid(),
  benefitType: z.enum(benefitTypes),
  jobId: z.uuid().nullable().optional(),
  idempotencyKey: z.uuid(),
});
export const membershipPolicySchema = z
  .object({
    accrualMinor: z.coerce.bigint().min(1n),
    unlockMinor: z.coerce.bigint().min(1n),
    capMinor: z.coerce.bigint().min(1n),
    repairDiscountBasisPoints: z.coerce.number().int().min(0).max(10000).default(1000),
    accessoryDiscountBasisPoints: z.coerce.number().int().min(0).max(10000).default(1500),
    maxAccessoryDiscountBasisPoints: z.coerce.number().int().min(0).max(10000).default(2000),
    cleaningIntervalDays: z.coerce.number().int().min(1).max(3650).default(90),
    workmanshipWarrantyDays: z.coerce.number().int().min(1).max(3650).default(90),
    gracePeriodDays: z.coerce.number().int().min(0).max(3650).default(0),
    forfeitureAfterDays: z.coerce.number().int().min(1).max(36500).nullable().optional(),
    restoreForfeitedCreditsOnReinstatement: z.boolean().default(false),
    effectiveFrom: z.coerce.date(),
  })
  .superRefine((value, context) => {
    if (value.capMinor < value.unlockMinor)
      context.addIssue({ code: 'custom', message: 'capMinor must be at least unlockMinor.' });
    if (
      value.forfeitureAfterDays !== null &&
      value.forfeitureAfterDays !== undefined &&
      value.forfeitureAfterDays <= value.gracePeriodDays
    )
      context.addIssue({
        code: 'custom',
        message: 'forfeitureAfterDays must exceed gracePeriodDays.',
      });
  });

export type DeviceCareEntitlement = {
  availableMinor: string;
  balanceMinor: string;
  benefits: Array<{
    eligible: boolean;
    nextEligibleAt: Date | null;
    type: (typeof benefitTypes)[number];
  }>;
  discounts: { accessoriesBasisPoints: number; repairsBasisPoints: number };
  maxStatus: boolean;
  membershipActive: boolean;
  policyVersion: number;
  usable: boolean;
};

type Page = z.infer<typeof deviceCarePageSchema>;
type MemberRow = {
  balance: string;
  customer_profile_id: string;
  membership_active: boolean;
  subscription_id: string;
  subscription_status: string;
};

export class DeviceCareEntitlementError extends Error {
  constructor(
    readonly code:
      | 'CUSTOMER_NOT_FOUND'
      | 'HOUSEHOLD_MEMBER_INVALID'
      | 'REPAIR_CREDIT_INELIGIBLE'
      | 'REPAIR_CREDIT_INSUFFICIENT'
      | 'BENEFIT_INELIGIBLE'
      | 'BENEFIT_INTERVAL_ACTIVE',
  ) {
    super(code);
  }
}

export class PostgresDeviceCareEntitlementRepository {
  constructor(private readonly databaseUrl: string) {}

  async forSubject(subject: string): Promise<DeviceCareEntitlement | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      const profile = await this.profileForSubject(client, subject);
      if (!profile) return null;
      return await this.entitlementForProfile(client, profile);
    } finally {
      await client.end();
    }
  }

  async reconcileDelinquencies(): Promise<number> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const candidates = await client.query<{ id: string; policy_id: string; balance: string }>(
        `SELECT cs.id,policy.id AS policy_id,COALESCE(SUM(l.amount_minor),0)::text AS balance
         FROM customer_subscriptions cs JOIN LATERAL (SELECT id,forfeiture_after_days FROM device_care_membership_policies WHERE effective_from<=now() AND (effective_to IS NULL OR effective_to>now()) ORDER BY version_number DESC LIMIT 1) policy ON true
         LEFT JOIN device_care_credit_ledger l ON l.customer_subscription_id=cs.id
         WHERE cs.status='past_due' AND cs.delinquent_at IS NOT NULL AND cs.delinquent_at<=now() - (policy.forfeiture_after_days || ' days')::interval
         GROUP BY cs.id,policy.id FOR UPDATE`,
      );
      let forfeited = 0;
      for (const row of candidates.rows) {
        if (BigInt(row.balance) <= 0n) continue;
        await client.query(
          `INSERT INTO device_care_credit_ledger (customer_subscription_id,membership_policy_id,entry_type,amount_minor,reason) VALUES ($1,$2,'forfeiture',$3,'Membership delinquent beyond configured forfeiture period')`,
          [row.id, row.policy_id, (-BigInt(row.balance)).toString()],
        );
        await this.audit(client, null, 'device_care.credits_forfeited', row.id, randomUUID(), {
          amountMinor: row.balance,
          delinquencyDays: 8,
        });
        forfeited += 1;
      }
      await client.query('COMMIT');
      return forfeited;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  async list(page: Page) {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      const rows = await client.query<MemberRow>(
        `WITH latest AS (
           SELECT DISTINCT ON (customer_profile_id) id,customer_profile_id,status
           FROM customer_subscriptions
           WHERE provider_subscription_reference IS NOT NULL
           ORDER BY customer_profile_id,updated_at DESC,id DESC
         ), balances AS (
           SELECT cs.customer_profile_id,COALESCE(SUM(l.amount_minor),0)::text AS balance
           FROM customer_subscriptions cs LEFT JOIN device_care_credit_ledger l ON l.customer_subscription_id=cs.id
           GROUP BY cs.customer_profile_id
         )
         SELECT latest.id AS subscription_id,latest.customer_profile_id,latest.status AS subscription_status,
           (latest.status='active') AS membership_active,COALESCE(balances.balance,'0') AS balance
         FROM latest LEFT JOIN balances ON balances.customer_profile_id=latest.customer_profile_id
         WHERE ($1::text IS NULL OR latest.status=$1)
         ORDER BY latest.customer_profile_id LIMIT $2 OFFSET $3`,
        [page.status ?? null, page.limit, page.offset],
      );
      const count = await client.query<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM (
           SELECT DISTINCT ON (customer_profile_id) status FROM customer_subscriptions
           WHERE provider_subscription_reference IS NOT NULL ORDER BY customer_profile_id,updated_at DESC,id DESC
         ) latest WHERE ($1::text IS NULL OR status=$1)`,
        [page.status ?? null],
      );
      return {
        items: rows.rows.map((row) => ({
          balanceMinor: row.balance,
          customerProfileId: row.customer_profile_id,
          membershipActive: row.membership_active,
          subscriptionId: row.subscription_id,
          subscriptionStatus: row.subscription_status,
        })),
        limit: page.limit,
        offset: page.offset,
        total: Number(count.rows[0]?.total ?? 0),
      };
    } finally {
      await client.end();
    }
  }

  async get(customerProfileId: string): Promise<DeviceCareEntitlement | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      const active = await client.query(
        "SELECT 1 FROM customer_profiles WHERE id=$1 AND status='active' AND archived_at IS NULL",
        [customerProfileId],
      );
      return active.rows[0] ? await this.entitlementForProfile(client, customerProfileId) : null;
    } finally {
      await client.end();
    }
  }

  async addHouseholdMember(
    subject: string,
    ownerProfileId: string,
    input: z.infer<typeof householdMemberSchema>,
    correlationId: string,
  ) {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const actorId = await this.userId(client, subject);
      if (!actorId) return null;
      const valid = await client.query(
        `SELECT COUNT(*)::int AS count FROM customer_profiles WHERE id IN ($1,$2) AND status='active' AND archived_at IS NULL`,
        [ownerProfileId, input.memberCustomerProfileId],
      );
      if (ownerProfileId === input.memberCustomerProfileId || valid.rows[0]?.count !== 2)
        throw new DeviceCareEntitlementError('HOUSEHOLD_MEMBER_INVALID');
      const prior = await client.query<{ id: string }>(
        `SELECT id FROM device_care_household_memberships WHERE verified_by_user_id=$1 AND idempotency_key=$2`,
        [actorId, input.idempotencyKey],
      );
      if (prior.rows[0]) {
        await client.query('COMMIT');
        return { id: prior.rows[0].id, status: 'active' as const };
      }
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO device_care_household_memberships (owner_customer_profile_id,member_customer_profile_id,relationship,idempotency_key,verified_by_user_id)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (owner_customer_profile_id,member_customer_profile_id) DO UPDATE
           SET relationship=EXCLUDED.relationship,verified_at=now(),verified_by_user_id=EXCLUDED.verified_by_user_id,ended_at=NULL,ended_by_user_id=NULL,end_reason=NULL
         RETURNING id`,
        [
          ownerProfileId,
          input.memberCustomerProfileId,
          input.relationship,
          input.idempotencyKey,
          actorId,
        ],
      );
      await this.audit(
        client,
        actorId,
        'device_care.household_verified',
        inserted.rows[0]!.id,
        correlationId,
        {
          ownerProfileId,
          memberProfileId: input.memberCustomerProfileId,
          relationship: input.relationship,
        },
      );
      await client.query('COMMIT');
      return { id: inserted.rows[0]!.id, status: 'active' as const };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  async applyRepairCredit(
    subject: string,
    input: z.infer<typeof applyRepairCreditSchema>,
    correlationId: string,
  ) {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const actorId = await this.userId(client, subject);
      if (!actorId) return null;
      const duplicate = await client.query<{ id: string; amount_minor: string }>(
        `SELECT id,amount_minor FROM device_care_credit_applications WHERE applied_by_user_id=$1 AND idempotency_key=$2`,
        [actorId, input.idempotencyKey],
      );
      if (duplicate.rows[0]) {
        await client.query('COMMIT');
        return { id: duplicate.rows[0].id, amountMinor: duplicate.rows[0].amount_minor };
      }
      const target = await client.query<{
        customer_profile_id: string;
        total_amount_minor: string;
      }>(
        `SELECT j.customer_profile_id,q.total_amount_minor::text FROM jobs j JOIN quotes q ON q.id=j.quote_id
         WHERE j.id=$1 AND q.id=$2 AND q.status='accepted' FOR UPDATE`,
        [input.jobId, input.quoteId],
      );
      const repair = target.rows[0];
      if (!repair?.customer_profile_id)
        throw new DeviceCareEntitlementError('REPAIR_CREDIT_INELIGIBLE');
      const subscription = await client.query<{
        id: string;
        customer_profile_id: string;
        policy_id: string;
        balance: string;
      }>(
        `SELECT cs.id,cs.customer_profile_id,policy.id AS policy_id,
           COALESCE((SELECT SUM(l.amount_minor) FROM device_care_credit_ledger l WHERE l.customer_subscription_id=cs.id),0)::text AS balance
         FROM customer_subscriptions cs JOIN LATERAL (SELECT id FROM device_care_membership_policies WHERE effective_from<=now() AND (effective_to IS NULL OR effective_to>now()) ORDER BY version_number DESC LIMIT 1) policy ON true
         WHERE cs.status='active' AND (cs.customer_profile_id=$1 OR cs.customer_profile_id IN (
           SELECT owner_customer_profile_id FROM device_care_household_memberships
           WHERE member_customer_profile_id=$1 AND ended_at IS NULL
         ))
         ORDER BY (cs.customer_profile_id=$1) DESC,cs.updated_at DESC LIMIT 1 FOR UPDATE`,
        [repair.customer_profile_id],
      );
      const member = subscription.rows[0];
      if (!member) throw new DeviceCareEntitlementError('REPAIR_CREDIT_INELIGIBLE');
      const prior = await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(amount_minor),0)::text AS total FROM device_care_credit_applications WHERE quote_id=$1`,
        [input.quoteId],
      );
      const outstanding = BigInt(repair.total_amount_minor) - BigInt(prior.rows[0]?.total ?? '0');
      if (input.amountMinor > BigInt(member.balance) || input.amountMinor > outstanding)
        throw new DeviceCareEntitlementError('REPAIR_CREDIT_INSUFFICIENT');
      const ledger = await client.query<{ id: string }>(
        `INSERT INTO device_care_credit_ledger (customer_subscription_id,membership_policy_id,entry_type,amount_minor,repair_job_id,quote_id,reason)
         VALUES ($1,$2,'redemption',$3,$4,$5,$6) RETURNING id`,
        [
          member.id,
          member.policy_id,
          (-input.amountMinor).toString(),
          input.jobId,
          input.quoteId,
          input.reason ?? null,
        ],
      );
      const application = await client.query<{ id: string }>(
        `INSERT INTO device_care_credit_applications (customer_subscription_id,customer_profile_id,repair_job_id,quote_id,ledger_entry_id,amount_minor,applied_by_user_id,idempotency_key,correlation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [
          member.id,
          member.customer_profile_id,
          input.jobId,
          input.quoteId,
          ledger.rows[0]!.id,
          input.amountMinor.toString(),
          actorId,
          input.idempotencyKey,
          correlationId,
        ],
      );
      await this.audit(
        client,
        actorId,
        'device_care.credit_applied',
        application.rows[0]!.id,
        correlationId,
        {
          amountMinor: input.amountMinor.toString(),
          customerProfileId: member.customer_profile_id,
          jobId: input.jobId,
          quoteId: input.quoteId,
        },
      );
      await client.query('COMMIT');
      return { id: application.rows[0]!.id, amountMinor: input.amountMinor.toString() };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  async redeemBenefit(
    subject: string,
    input: z.infer<typeof benefitRedemptionSchema>,
    correlationId: string,
  ) {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      await client.query('BEGIN');
      const actorId = await this.userId(client, subject);
      if (!actorId) return null;
      const duplicate = await client.query<{ id: string }>(
        `SELECT id FROM device_care_benefit_redemptions WHERE redeemed_by_user_id=$1 AND idempotency_key=$2`,
        [actorId, input.idempotencyKey],
      );
      if (duplicate.rows[0]) {
        await client.query('COMMIT');
        return { id: duplicate.rows[0].id, status: 'redeemed' as const };
      }
      const entitlement = await this.entitlementForProfile(client, input.customerProfileId);
      const benefit = entitlement.benefits.find((item) => item.type === input.benefitType);
      if (!benefit?.eligible)
        throw new DeviceCareEntitlementError(
          input.benefitType === 'device_cleaning'
            ? 'BENEFIT_INTERVAL_ACTIVE'
            : 'BENEFIT_INELIGIBLE',
        );
      const subscription = await client.query<{ id: string }>(
        `SELECT id FROM customer_subscriptions WHERE customer_profile_id=$1 AND status='active' ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
        [input.customerProfileId],
      );
      const policy = await client.query<{ id: string }>(
        `SELECT id FROM device_care_membership_policies WHERE effective_from<=now() AND (effective_to IS NULL OR effective_to>now()) ORDER BY version_number DESC LIMIT 1`,
      );
      if (!subscription.rows[0] || !policy.rows[0])
        throw new DeviceCareEntitlementError('BENEFIT_INELIGIBLE');
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO device_care_benefit_redemptions (customer_subscription_id,customer_profile_id,membership_policy_id,benefit_type,repair_job_id,idempotency_key,redeemed_by_user_id,correlation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [
          subscription.rows[0].id,
          input.customerProfileId,
          policy.rows[0].id,
          input.benefitType,
          input.jobId ?? null,
          input.idempotencyKey,
          actorId,
          correlationId,
        ],
      );
      await this.audit(
        client,
        actorId,
        'device_care.benefit_redeemed',
        inserted.rows[0]!.id,
        correlationId,
        {
          customerProfileId: input.customerProfileId,
          benefitType: input.benefitType,
          jobId: input.jobId ?? null,
        },
      );
      await client.query('COMMIT');
      return { id: inserted.rows[0]!.id, status: 'redeemed' as const };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  }

  private async entitlementForProfile(
    client: Client,
    profileId: string,
  ): Promise<DeviceCareEntitlement> {
    const policy = await client.query<{
      id: string;
      version_number: number;
      unlock_minor: string;
      cap_minor: string;
      repair_discount_basis_points: number;
      accessory_discount_basis_points: number;
      max_accessory_discount_basis_points: number;
      cleaning_interval_days: number;
      workmanship_warranty_days: number;
    }>(
      `SELECT id,version_number,unlock_minor::text,cap_minor::text,repair_discount_basis_points,accessory_discount_basis_points,max_accessory_discount_basis_points,cleaning_interval_days,workmanship_warranty_days FROM device_care_membership_policies WHERE effective_from<=now() AND (effective_to IS NULL OR effective_to>now()) ORDER BY version_number DESC LIMIT 1`,
    );
    const current = policy.rows[0];
    if (!current) throw new Error('No active Device Care membership policy exists.');
    const subscription = await client.query<{ id: string; active: boolean; balance: string }>(
      `SELECT cs.id,(cs.status='active' OR (cs.status='past_due' AND cs.delinquent_at>now() - (policy.grace_period_days || ' days')::interval)) AS active,COALESCE(SUM(l.amount_minor),0)::text AS balance FROM customer_subscriptions cs LEFT JOIN device_care_credit_ledger l ON l.customer_subscription_id=cs.id CROSS JOIN LATERAL (SELECT grace_period_days FROM device_care_membership_policies WHERE effective_from<=now() AND (effective_to IS NULL OR effective_to>now()) ORDER BY version_number DESC LIMIT 1) policy WHERE cs.customer_profile_id=$1 GROUP BY cs.id,policy.grace_period_days ORDER BY cs.updated_at DESC LIMIT 1`,
      [profileId],
    );
    const row = subscription.rows[0];
    const active = row?.active ?? false;
    const balance = BigInt(row?.balance ?? '0');
    const cap = BigInt(current.cap_minor);
    const capped = balance < 0n ? 0n : balance > cap ? cap : balance;
    const maxStatus = active && capped >= cap;
    const cleaning = await client.query<{ created_at: Date }>(
      `SELECT created_at FROM device_care_benefit_redemptions WHERE customer_profile_id=$1 AND benefit_type='device_cleaning' ORDER BY created_at DESC LIMIT 1`,
      [profileId],
    );
    const nextCleaning = cleaning.rows[0]
      ? new Date(cleaning.rows[0].created_at.getTime() + current.cleaning_interval_days * 86400000)
      : null;
    const cleanEligible = active && maxStatus && (!nextCleaning || nextCleaning <= new Date());
    const maxBenefit = active && maxStatus;
    return {
      availableMinor: active && capped >= BigInt(current.unlock_minor) ? capped.toString() : '0',
      balanceMinor: capped.toString(),
      discounts: active
        ? {
            repairsBasisPoints: current.repair_discount_basis_points,
            accessoriesBasisPoints: maxStatus
              ? current.max_accessory_discount_basis_points
              : current.accessory_discount_basis_points,
          }
        : { repairsBasisPoints: 0, accessoriesBasisPoints: 0 },
      maxStatus,
      membershipActive: active,
      policyVersion: current.version_number,
      usable: active && capped >= BigInt(current.unlock_minor),
      benefits: benefitTypes.map((type) => ({
        type,
        eligible: type === 'device_cleaning' ? cleanEligible : maxBenefit,
        nextEligibleAt:
          type === 'device_cleaning' && nextCleaning && nextCleaning > new Date()
            ? nextCleaning
            : null,
      })),
    };
  }
  private async profileForSubject(client: Client, subject: string) {
    const result = await client.query<{ id: string }>(
      `SELECT cp.id FROM identities i JOIN customer_profile_memberships cpm ON cpm.user_id=i.user_id JOIN customer_profiles cp ON cp.id=cpm.customer_profile_id WHERE i.provider_subject=$1 AND cp.status='active' AND cp.archived_at IS NULL ORDER BY cpm.created_at LIMIT 1`,
      [subject],
    );
    return result.rows[0]?.id ?? null;
  }
  private async userId(client: Client, subject: string) {
    const result = await client.query<{ id: string }>(
      `SELECT i.user_id AS id FROM identities i JOIN users u ON u.id=i.user_id WHERE i.provider_subject=$1 AND u.status='active' AND u.archived_at IS NULL`,
      [subject],
    );
    return result.rows[0]?.id ?? null;
  }
  private async audit(
    client: Client,
    actorUserId: string | null,
    action: string,
    targetId: string,
    correlationId: string,
    afterValue: Record<string, unknown>,
  ) {
    const event = createAuditEvent({
      actorUserId,
      action,
      targetType: 'device_care_entitlement',
      targetId,
      correlationId,
      reason: null,
      beforeValue: null,
      afterValue,
    });
    await client.query(
      `INSERT INTO audit_events (actor_user_id,action,target_type,target_id,correlation_id,reason,before_value,after_value,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        event.actorUserId,
        event.action,
        event.targetType,
        event.targetId,
        event.correlationId,
        event.reason,
        event.beforeValue,
        event.afterValue,
        event.occurredAt,
      ],
    );
  }
}
