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
  overviewForSubject(subject: string): Promise<ExecutiveOverview | null>;
};
export type ExecutiveOverview = {
  current: OperatingAggregateSnapshot | null;
  previous: OperatingAggregateSnapshot | null;
};
export type OperatingAggregateSnapshot = {
  aggregationDate: string;
  collectedRevenueMinor: string;
  estimatedCommissionsMinor: string;
  estimatedHourlyWagesMinor: string;
  finalizedPayrollMinor: string | null;
  netSalesMinor: string;
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
        `WITH scoped AS (SELECT ur.organization_id FROM identities i JOIN user_roles ur ON ur.user_id=i.user_id JOIN roles r ON r.id=ur.role_id JOIN role_permissions rp ON rp.role_id=r.id JOIN permissions p ON p.id=rp.permission_id WHERE i.provider='auth0' AND i.provider_subject=$1 AND p.key='reporting.read' AND ur.effective_from<=now() AND (ur.effective_to IS NULL OR ur.effective_to>now())) SELECT doa.aggregation_date,doa.scope_type,doa.net_sales_minor FROM daily_operating_aggregates doa LEFT JOIN districts d ON d.id=doa.district_id LEFT JOIN stores st ON st.id=doa.store_id LEFT JOIN districts std ON std.id=st.district_id LEFT JOIN business_units bu ON bu.id=COALESCE(d.business_unit_id,std.business_unit_id) WHERE EXISTS (SELECT 1 FROM scoped s WHERE s.organization_id IS NULL OR s.organization_id=COALESCE(doa.organization_id,bu.organization_id)) ORDER BY doa.aggregation_date DESC`,
        [subject],
      );
      return r.rows.map((x) => ({
        aggregationDate: formatAggregationDate(x.aggregation_date),
        scopeType: x.scope_type,
        netSalesMinor: x.net_sales_minor,
      }));
    } finally {
      await client.end();
    }
  }
  async overviewForSubject(subject: string): Promise<ExecutiveOverview | null> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      const result = await client.query<{
        aggregation_date: string;
        collected_revenue_minor: string;
        estimated_commissions_minor: string;
        estimated_hourly_wages_minor: string;
        finalized_payroll_minor: string | null;
        net_sales_minor: string;
        period: 'current' | 'previous';
      }>(
        `WITH scoped AS (
           SELECT ur.organization_id FROM identities i JOIN user_roles ur ON ur.user_id=i.user_id
           JOIN roles r ON r.id=ur.role_id JOIN role_permissions rp ON rp.role_id=r.id
           JOIN permissions p ON p.id=rp.permission_id
           WHERE i.provider='auth0' AND i.provider_subject=$1 AND p.key='reporting.read'
             AND ur.effective_from<=now() AND (ur.effective_to IS NULL OR ur.effective_to>now())
         ), visible AS (
           SELECT doa.* FROM daily_operating_aggregates doa
           LEFT JOIN districts d ON d.id=doa.district_id LEFT JOIN stores st ON st.id=doa.store_id
           LEFT JOIN districts std ON std.id=st.district_id
           LEFT JOIN business_units bu ON bu.id=COALESCE(d.business_unit_id,std.business_unit_id)
           WHERE EXISTS (SELECT 1 FROM scoped s WHERE s.organization_id IS NULL OR s.organization_id=COALESCE(doa.organization_id,bu.organization_id))
         ), dates AS (
           SELECT max(aggregation_date) latest_aggregation_date FROM visible
         ), periods AS (
           SELECT latest_aggregation_date,
             (SELECT max(aggregation_date) FROM visible WHERE aggregation_date < latest_aggregation_date) previous_aggregation_date
           FROM dates
         )
         SELECT CASE WHEN v.aggregation_date=p.latest_aggregation_date THEN 'current' ELSE 'previous' END period,
           v.aggregation_date, sum(v.net_sales_minor)::text net_sales_minor,
           sum(v.collected_revenue_minor)::text collected_revenue_minor,
           sum(v.estimated_hourly_wages_minor)::text estimated_hourly_wages_minor,
           sum(v.estimated_commissions_minor)::text estimated_commissions_minor,
           CASE WHEN count(v.finalized_payroll_minor)=0 THEN NULL ELSE sum(v.finalized_payroll_minor)::text END finalized_payroll_minor
         FROM visible v CROSS JOIN periods p
         WHERE v.aggregation_date IN (p.latest_aggregation_date,p.previous_aggregation_date)
         GROUP BY period,v.aggregation_date ORDER BY v.aggregation_date DESC`,
        [subject],
      );
      const snapshots = Object.fromEntries(
        result.rows.map((row) => [
          row.period,
          {
            aggregationDate: formatAggregationDate(row.aggregation_date),
            collectedRevenueMinor: row.collected_revenue_minor,
            estimatedCommissionsMinor: row.estimated_commissions_minor,
            estimatedHourlyWagesMinor: row.estimated_hourly_wages_minor,
            finalizedPayrollMinor: row.finalized_payroll_minor,
            netSalesMinor: row.net_sales_minor,
          },
        ]),
      ) as Partial<Record<'current' | 'previous', OperatingAggregateSnapshot>>;
      return { current: snapshots.current ?? null, previous: snapshots.previous ?? null };
    } finally {
      await client.end();
    }
  }
}

function formatAggregationDate(value: string | Date): string {
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}
