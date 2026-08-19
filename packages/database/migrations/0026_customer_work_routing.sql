CREATE TABLE customer_work_routing_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_type text NOT NULL CHECK (work_type IN ('communication_call','repair_job')),
  work_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  action text NOT NULL CHECK (action IN ('routed','reassigned','unassigned','escalated','completed')),
  previous_employee_profile_id uuid REFERENCES employee_profiles(id),
  employee_profile_id uuid REFERENCES employee_profiles(id),
  priority text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  reason text NOT NULL,
  idempotency_key uuid NOT NULL,
  correlation_id uuid NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (actor_user_id, idempotency_key)
);
CREATE INDEX customer_work_routing_assignee_idx ON customer_work_routing_events (employee_profile_id, occurred_at DESC);

CREATE TABLE customer_work_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_type text NOT NULL CHECK (work_type IN ('communication_call','repair_job')),
  work_id uuid NOT NULL,
  employee_profile_id uuid NOT NULL REFERENCES employee_profiles(id),
  type text NOT NULL CHECK (type IN ('routed','escalated')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','read','completed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX customer_work_notifications_assignee_idx ON customer_work_notifications (employee_profile_id,status,created_at DESC);

INSERT INTO permissions (key,name) VALUES
  ('customer.work.route','Route customer repair and communications work within management scope'),
  ('customer.work.escalate','Escalate assigned customer work'),
  ('customer.work.complete','Complete owned customer work follow-up'),
  ('customer.work.manage','Manage company-wide customer work routing')
ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name,updated_at=now();
INSERT INTO role_permissions (role_id,permission_id)
SELECT r.id,p.id FROM roles r JOIN applications a ON a.id=r.application_id JOIN permissions p ON p.key='customer.work.manage'
WHERE a.key='core-admin' AND r.key='super-admin' ON CONFLICT DO NOTHING;
