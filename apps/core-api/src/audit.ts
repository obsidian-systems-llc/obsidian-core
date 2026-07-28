import { randomUUID } from 'node:crypto';

import { z } from 'zod';

const forbiddenKeys = /card(number)?|cvv|cvc|password|secret|token/i;

export const auditEventSchema = z.object({
  actorUserId: z.uuid().nullable(),
  action: z.string().min(1),
  targetType: z.string().min(1),
  targetId: z.uuid().nullable(),
  correlationId: z.uuid(),
  reason: z.string().min(1).nullable(),
  beforeValue: z.record(z.string(), z.unknown()).nullable(),
  afterValue: z.record(z.string(), z.unknown()).nullable(),
  occurredAt: z.coerce.date(),
});

export type AuditEvent = z.infer<typeof auditEventSchema>;

function assertSafeMetadata(value: Record<string, unknown> | null): void {
  if (value && Object.keys(value).some((key) => forbiddenKeys.test(key))) {
    throw new Error('Audit metadata contains a prohibited sensitive field.');
  }
}

export function createAuditEvent(
  input: Omit<AuditEvent, 'correlationId' | 'occurredAt'> &
    Partial<Pick<AuditEvent, 'correlationId' | 'occurredAt'>>,
): AuditEvent {
  assertSafeMetadata(input.beforeValue ?? null);
  assertSafeMetadata(input.afterValue ?? null);
  return auditEventSchema.parse({
    ...input,
    correlationId: input.correlationId ?? randomUUID(),
    occurredAt: input.occurredAt ?? new Date(),
  });
}
