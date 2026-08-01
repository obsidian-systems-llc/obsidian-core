export type OperatingAggregate = {
  collectedRevenueMinor: bigint;
  estimatedCommissionsMinor: bigint;
  estimatedHourlyWagesMinor: bigint;
  netSalesMinor: bigint;
};
export function laborCostMinor(value: OperatingAggregate): bigint {
  return value.estimatedHourlyWagesMinor + value.estimatedCommissionsMinor;
}
export function laborToSalesBasisPoints(value: OperatingAggregate): bigint | null {
  return value.netSalesMinor === 0n ? null : (laborCostMinor(value) * 10000n) / value.netSalesMinor;
}
import { Client } from 'pg';
export type ReportingRepository = {
  listForSubject(
    subject: string,
  ): Promise<Array<{ aggregationDate: string; scopeType: string; netSalesMinor: string }> | null>;
};
export class PostgresReportingRepository implements ReportingRepository {
  constructor(private readonly databaseUrl: string) {}
  async listForSubject(subject: string) {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      const r = await client.query<{
        aggregation_date: string;
        scope_type: string;
        net_sales_minor: string;
      }>(
        `WITH scoped AS (SELECT ur.organization_id FROM identities i JOIN user_roles ur ON ur.user_id=i.user_id JOIN roles r ON r.id=ur.role_id JOIN role_permissions rp ON rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id WHERE i.provider='auth0' AND i.provider_subject=$1 AND p.key='reporting.read' AND ur.effective_from<=now() AND (ur.effective_to IS NULL OR ur.effective_to>now())) SELECT doa.aggregation_date,doa.scope_type,doa.net_sales_minor FROM daily_operating_aggregates doa WHERE EXISTS (SELECT 1 FROM scoped s WHERE s.organization_id IS NULL OR s.organization_id=doa.organization_id) ORDER BY doa.aggregation_date DESC`,
        [subject],
      );
      return r.rows.map((x) => ({
        aggregationDate: x.aggregation_date,
        scopeType: x.scope_type,
        netSalesMinor: x.net_sales_minor,
      }));
    } finally {
      await client.end();
    }
  }
}
