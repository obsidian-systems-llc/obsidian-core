CREATE INDEX business_units_organization_id_idx ON business_units (organization_id) WHERE deactivated_at IS NULL;
CREATE INDEX districts_business_unit_id_idx ON districts (business_unit_id) WHERE deactivated_at IS NULL;
CREATE INDEX stores_district_id_idx ON stores (district_id) WHERE deactivated_at IS NULL;
CREATE INDEX departments_store_id_idx ON departments (store_id) WHERE deactivated_at IS NULL;
