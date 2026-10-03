CREATE TABLE IF NOT EXISTS operational_anonymous_event (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type TEXT NOT NULL CHECK (event_type IN ('origin', 'calculation', 'calculation_error')),
  origin_class TEXT NOT NULL CHECK (origin_class IN ('direct', 'search', 'referral', 'internal', 'unknown')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS operational_anonymous_event_created
  ON operational_anonymous_event (created_at DESC, event_type);

CREATE TABLE IF NOT EXISTS operational_failure_event (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('email', 'webhook')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS operational_failure_event_created
  ON operational_failure_event (created_at DESC, kind);

CREATE TABLE IF NOT EXISTS operational_verified_signup (
  user_id TEXT PRIMARY KEY REFERENCES "user"(id) ON DELETE CASCADE,
  verified_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS operational_account_event (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('csv_exported')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS operational_account_event_user_created
  ON operational_account_event (user_id, created_at DESC);

-- Existing verified users have only an approximate timestamp from Better Auth.
INSERT INTO operational_verified_signup (user_id, verified_at)
SELECT id, "updatedAt" FROM "user" WHERE "emailVerified" = TRUE
ON CONFLICT (user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION record_verified_signup() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."emailVerified" = TRUE AND
    (TG_OP = 'INSERT' OR OLD."emailVerified" IS DISTINCT FROM TRUE) THEN
    INSERT INTO operational_verified_signup (user_id, verified_at)
    VALUES (NEW.id, NOW()) ON CONFLICT (user_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS user_verified_signup_event ON "user";
CREATE TRIGGER user_verified_signup_event
  AFTER INSERT OR UPDATE OF "emailVerified" ON "user"
  FOR EACH ROW EXECUTE FUNCTION record_verified_signup();

-- Source rows are the event ledger. The view has no arbitrary client payload.
CREATE OR REPLACE VIEW operational_funnel_event AS
SELECT 'origin'::TEXT AS event_type, NULL::TEXT AS user_id, created_at AS occurred_at
  FROM operational_anonymous_event WHERE event_type = 'origin'
UNION ALL SELECT event_type, NULL::TEXT, created_at
  FROM operational_anonymous_event WHERE event_type IN ('calculation', 'calculation_error')
UNION ALL SELECT 'signup_verified', user_id, verified_at
  FROM operational_verified_signup
UNION ALL SELECT event_type, user_id, created_at FROM operational_account_event
UNION ALL SELECT 'simulation_saved', user_id, created_at FROM saved_simulation
UNION ALL SELECT 'product_created', user_id, created_at FROM catalog_product
UNION ALL SELECT 'product_evaluated', p.user_id, e.created_at
  FROM catalog_product_evaluation e JOIN catalog_product p ON p.id = e.product_id
UNION ALL SELECT 'csv_confirmed', user_id, confirmed_at
  FROM catalog_import_preview WHERE confirmed_at IS NOT NULL
UNION ALL SELECT 'reprice_confirmed', user_id, confirmed_at
  FROM catalog_batch_reprice_preview WHERE confirmed_at IS NOT NULL
UNION ALL SELECT 'checkout_started', user_id, created_at FROM billing_order
UNION ALL SELECT
  CASE WHEN c.is_initial THEN 'payment_confirmed' ELSE 'renewal_confirmed' END,
  c.user_id,
  p.occurred_at
  FROM billing_payment_cycle c
  LEFT JOIN billing_order o ON o.id = c.order_id
  CROSS JOIN LATERAL (
    SELECT LEAST(
      MIN(e.received_at),
      CASE WHEN c.is_initial THEN o.paid_at END
    ) AS occurred_at
    FROM billing_payment_event e
    WHERE e.payment_id = c.payment_id
      AND e.event_type IN ('PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED')
      AND e.outcome IN ('confirmed', 'paid_duplicate_financial')
  ) p
  WHERE p.occurred_at IS NOT NULL
UNION ALL SELECT 'payment_overdue', c.user_id, e.received_at
  FROM billing_payment_event e JOIN billing_payment_cycle c ON c.payment_id = e.payment_id
  WHERE e.event_type IN ('PAYMENT_OVERDUE', 'PAYMENT_CREDIT_CARD_CAPTURE_REFUSED')
    AND e.outcome = 'overdue'
UNION ALL SELECT 'cancellation_requested', user_id, cancellation_requested_at
  FROM billing_order WHERE cancellation_requested_at IS NOT NULL
UNION ALL SELECT 'cancellation_confirmed', user_id, cancellation_confirmed_at
  FROM billing_order WHERE cancellation_confirmed_at IS NOT NULL;

-- This is an audit of actual entitlement row changes, including system changes.
-- Missing context is visible as unattributed; operators must use the function below.
CREATE TABLE IF NOT EXISTS access_change_audit (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id TEXT NOT NULL,
  old_plan TEXT,
  new_plan TEXT NOT NULL,
  old_expires_at TIMESTAMPTZ,
  new_expires_at TIMESTAMPTZ,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS access_change_audit_user_changed
  ON access_change_audit (user_id, changed_at DESC);

CREATE OR REPLACE FUNCTION audit_entitlement_change() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' OR OLD.plan IS DISTINCT FROM NEW.plan OR
    OLD.expires_at IS DISTINCT FROM NEW.expires_at THEN
    INSERT INTO access_change_audit (user_id, old_plan, new_plan,
      old_expires_at, new_expires_at, actor, reason)
    VALUES (NEW.user_id, CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.plan END,
      NEW.plan, CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.expires_at END,
      NEW.expires_at,
      COALESCE(NULLIF(current_setting('app.access_actor', TRUE), ''), 'unattributed'),
      COALESCE(NULLIF(current_setting('app.access_reason', TRUE), ''), 'direct_database_change'));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS account_entitlement_audit ON account_entitlement;
CREATE TRIGGER account_entitlement_audit AFTER INSERT OR UPDATE ON account_entitlement
  FOR EACH ROW EXECUTE FUNCTION audit_entitlement_change();

CREATE OR REPLACE FUNCTION set_operator_entitlement(
  target_user_id TEXT, target_plan TEXT, target_expires_at TIMESTAMPTZ,
  operator_id TEXT, change_reason TEXT
) RETURNS VOID AS $$
BEGIN
  IF operator_id IS NULL OR length(btrim(operator_id)) < 3 OR
    change_reason IS NULL OR length(btrim(change_reason)) < 10 OR
    target_plan NOT IN ('free', 'pro') OR
    (target_plan = 'pro' AND (target_expires_at IS NULL OR target_expires_at <= NOW())) THEN
    RAISE EXCEPTION 'Invalid operator access change';
  END IF;
  PERFORM set_config('app.access_actor', operator_id, TRUE);
  PERFORM set_config('app.access_reason', change_reason, TRUE);
  INSERT INTO account_entitlement (user_id, plan, expires_at, updated_at)
  VALUES (target_user_id, target_plan, target_expires_at, NOW())
  ON CONFLICT (user_id) DO UPDATE SET plan = EXCLUDED.plan,
    expires_at = EXCLUDED.expires_at, updated_at = NOW();
END;
$$ LANGUAGE plpgsql;
