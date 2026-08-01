import { Client } from 'pg';

export type Department = { code: string; id: string; name: string; storeId: string | null };
export type Store = { code: string; departments: Department[]; id: string; name: string };
export type District = { code: string; id: string; name: string; stores: Store[] };
export type BusinessUnit = { code: string; districts: District[]; id: string; name: string };
export type Organization = {
  code: string;
  businessUnits: BusinessUnit[];
  id: string;
  name: string;
};
export type OrganizationHierarchy = {
  organizations: Organization[];
  unassignedDepartments: Department[];
};

export type OrganizationRepository = {
  getHierarchy(): Promise<OrganizationHierarchy>;
};

type Row = { code: string; id: string; name: string };
type ChildRow = Row & { parent_id: string | null };

export class PostgresOrganizationRepository implements OrganizationRepository {
  constructor(private readonly databaseUrl: string) {}

  async getHierarchy(): Promise<OrganizationHierarchy> {
    const client = new Client({ connectionString: this.databaseUrl });
    try {
      await client.connect();
      const organizations = await client.query<Row>(
        'SELECT id, code, name FROM organizations WHERE deactivated_at IS NULL ORDER BY code',
      );
      const businessUnits = await client.query<ChildRow>(
        'SELECT id, organization_id AS parent_id, code, name FROM business_units WHERE deactivated_at IS NULL ORDER BY code',
      );
      const districts = await client.query<ChildRow>(
        'SELECT id, business_unit_id AS parent_id, code, name FROM districts WHERE deactivated_at IS NULL ORDER BY code',
      );
      const stores = await client.query<ChildRow>(
        'SELECT id, district_id AS parent_id, code, name FROM stores WHERE deactivated_at IS NULL ORDER BY code',
      );
      const departments = await client.query<ChildRow>(
        'SELECT id, store_id AS parent_id, code, name FROM departments WHERE deactivated_at IS NULL ORDER BY code',
      );

      const storesByDistrict = new Map<string, Store[]>();
      const storeById = new Map<string, Store>();
      for (const store of stores.rows) {
        const item: Store = { ...store, departments: [] };
        storeById.set(item.id, item);
        if (store.parent_id) {
          const children = storesByDistrict.get(store.parent_id) ?? [];
          children.push(item);
          storesByDistrict.set(store.parent_id, children);
        }
      }

      const unassignedDepartments: Department[] = [];
      for (const department of departments.rows) {
        const item: Department = {
          code: department.code,
          id: department.id,
          name: department.name,
          storeId: department.parent_id,
        };
        if (department.parent_id && storeById.has(department.parent_id)) {
          storeById.get(department.parent_id)?.departments.push(item);
        } else {
          unassignedDepartments.push(item);
        }
      }

      const districtsByBusinessUnit = new Map<string, District[]>();
      for (const district of districts.rows) {
        if (!district.parent_id) continue;
        const children = districtsByBusinessUnit.get(district.parent_id) ?? [];
        children.push({ ...district, stores: storesByDistrict.get(district.id) ?? [] });
        districtsByBusinessUnit.set(district.parent_id, children);
      }

      const unitsByOrganization = new Map<string, BusinessUnit[]>();
      for (const businessUnit of businessUnits.rows) {
        if (!businessUnit.parent_id) continue;
        const children = unitsByOrganization.get(businessUnit.parent_id) ?? [];
        children.push({
          ...businessUnit,
          districts: districtsByBusinessUnit.get(businessUnit.id) ?? [],
        });
        unitsByOrganization.set(businessUnit.parent_id, children);
      }

      return {
        organizations: organizations.rows.map((organization) => ({
          ...organization,
          businessUnits: unitsByOrganization.get(organization.id) ?? [],
        })),
        unassignedDepartments,
      };
    } finally {
      await client.end();
    }
  }
}
