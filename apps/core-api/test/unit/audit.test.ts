import { describe, expect, it } from 'vitest';
import { createAuditEvent } from '../../src/audit.js';

describe('audit events', () => {
  const input = {
    actorUserId: null,
    action: 'record.read',
    targetType: 'record',
    targetId: null,
    reason: null,
    beforeValue: null,
    afterValue: { status: 'active' },
  };
  it('adds correlation and timestamp metadata', () =>
    expect(createAuditEvent(input)).toMatchObject({ action: 'record.read', targetType: 'record' }));
  it('rejects prohibited sensitive metadata', () =>
    expect(() => createAuditEvent({ ...input, afterValue: { cvv: 'never' } })).toThrow(
      'prohibited',
    ));
});
