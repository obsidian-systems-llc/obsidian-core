CREATE TABLE payment_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('square', 'worldpay')),
  provider_payment_reference text,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'completed', 'cancelled', 'failed')),
  currency char(3) NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  idempotency_key uuid NOT NULL,
  created_by_user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, idempotency_key),
  UNIQUE NULLS NOT DISTINCT (provider, provider_payment_reference)
);
CREATE INDEX payment_operations_creator_idx ON payment_operations (created_by_user_id, created_at DESC);

CREATE TABLE payment_refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_operation_id uuid NOT NULL REFERENCES payment_operations(id),
  provider_refund_reference text,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'refunded', 'failed')),
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  idempotency_key uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (payment_operation_id, idempotency_key),
  UNIQUE NULLS NOT DISTINCT (provider_refund_reference)
);

CREATE TABLE payment_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL CHECK (provider IN ('square', 'worldpay')),
  provider_event_reference text NOT NULL,
  event_type text NOT NULL,
  payload_sha256 char(64) NOT NULL,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'processed', 'failed')),
  occurred_at timestamptz NOT NULL,
  processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_event_reference)
);
