-- Phase 7: Payment Architecture + Cashfree Test Integration
--
-- Adds a provider-agnostic payment layer on top of the existing, unmodified
-- booking engine. Cashfree (test/sandbox only) is the first PaymentProvider
-- implementation (src/modules/payments/providers/CashfreeProvider.ts); a
-- future Razorpay adapter is a new provider value + adapter file, not a
-- schema rewrite -- nothing here names Cashfree in a column definition.
--
-- Booking status is NOT touched by this migration and is NOT gated on
-- payment: a payment is a bolt-on financial record attached to an existing
-- requested/confirmed booking (see docs/DATABASE.md for the full reasoning).
-- bookings.total_amount_minor_units/currency (Phase 6/6A, immutable once
-- set) remains the sole source of the amount charged -- this migration never
-- adds a way to charge a different amount than what's already on the
-- booking.

-- ============================================================================
-- payments -- one row per payment attempt against a booking. Retries after a
-- failed/expired attempt create a new row rather than mutating the old one,
-- so the full attempt history is preserved.
-- ============================================================================

create table public.payments (
  id uuid primary key default gen_random_uuid(),

  -- No `on delete cascade`, matching bookings.location_id's own precedent --
  -- bookings are never hard-deleted anyway (no DELETE policy/endpoint
  -- exists), but a financial record should never silently disappear via an
  -- unrelated schema change either.
  booking_id uuid not null references public.bookings (id),

  -- Extended by a later migration's CHECK when Razorpay ships -- never a
  -- generic free-text column, so an unrecognized provider can't sneak in.
  provider text not null check (provider in ('cashfree')),

  -- The order id WE generate and send the provider (this row's own id,
  -- formatted -- see payment.service.ts). Unique per provider so the same
  -- provider can never be asked to create two orders under one id.
  provider_order_id text not null,
  -- The provider's OWN identifier for that order/payment (Cashfree's
  -- cf_order_id / cf_payment_id), filled in once the provider responds.
  provider_reference_id text,

  status text not null default 'created'
    check (status in ('created', 'pending', 'success', 'failed', 'cancelled', 'refunded', 'partially_refunded')),

  -- Copied from bookings.total_amount_minor_units/currency at creation and
  -- never recomputed -- the booking's own immutable snapshot (Phase 6/6A)
  -- stays the one source of truth for what a booking costs; this is just
  -- what was actually asked of the payment provider for this attempt.
  amount_minor_units integer not null check (amount_minor_units >= 0),
  currency text not null check (currency ~ '^[A-Z]{3}$'),

  failure_reason text,

  -- Last known raw provider response/webhook payload -- audit/debug only.
  -- Never serialized into any API response (see payment.service.ts).
  provider_raw jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (provider, provider_order_id)
);

comment on table public.payments is
  'One row per payment attempt against a booking. amount_minor_units/currency '
  'are copied from the booking''s own immutable price snapshot at creation, '
  'never recomputed. status is a normalized cross-provider model (see '
  'docs/DATABASE.md for the Cashfree status mapping), never a raw provider '
  'status string.';

-- At most one "in-flight" attempt per booking at a time -- prevents a
-- double-submit race from creating two simultaneous provider orders for the
-- same booking. A booking with a failed/cancelled prior attempt can still
-- get a fresh row (retry), since only created/pending participate.
create unique index payments_one_inflight_per_booking
  on public.payments (booking_id)
  where (status in ('created', 'pending'));

create index payments_booking_id_idx on public.payments (booking_id);

create trigger set_payments_updated_at
  before update on public.payments
  for each row
  execute function public.set_updated_at();

-- ============================================================================
-- payment_refunds -- one row per refund attempt against a payment. A full
-- refund is amount_minor_units = the payment's own amount; a partial refund
-- is smaller. The service layer validates the running total against the
-- payment's amount before ever calling the provider -- no refund policy
-- engine, just arithmetic (see docs/DATABASE.md).
-- ============================================================================

create table public.payment_refunds (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid not null references public.payments (id),

  provider_refund_id text not null,
  provider_reference_id text,

  status text not null default 'pending'
    check (status in ('pending', 'success', 'failed', 'cancelled')),

  amount_minor_units integer not null check (amount_minor_units > 0),
  reason text,

  provider_raw jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (payment_id, provider_refund_id)
);

comment on table public.payment_refunds is
  'One row per refund attempt against a payment. Full vs. partial is just '
  'amount_minor_units relative to the parent payment -- refund POLICY (who '
  'gets refunded how much on a cancellation) is a separate, later concern '
  'from refund EXECUTION, which is all this table represents.';

create index payment_refunds_payment_id_idx on public.payment_refunds (payment_id);

create trigger set_payment_refunds_updated_at
  before update on public.payment_refunds
  for each row
  execute function public.set_updated_at();

-- ============================================================================
-- payment_webhook_events -- idempotency ledger. Cashfree's webhook payloads
-- don't expose one canonical event-id field the way some providers do, so
-- idempotency is keyed on a hash of the exact raw body instead: an exact
-- redelivery (providers redeliver at-least-once) is caught here before any
-- business logic runs. Out-of-order-but-distinct events (e.g. a delayed
-- PENDING arriving after a SUCCESS) are handled separately, in
-- payment.service.ts, by never letting a payment regress out of a terminal
-- status -- this table only stops the SAME delivery being processed twice.
-- ============================================================================

create table public.payment_webhook_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('cashfree')),
  raw_body_hash text not null,
  payload jsonb not null,
  payment_id uuid references public.payments (id),

  received_at timestamptz not null default now(),
  processed_at timestamptz,

  unique (provider, raw_body_hash)
);

comment on table public.payment_webhook_events is
  'Append-only audit + idempotency ledger for every payment webhook delivery '
  'received, keyed by sha256(raw request body). Internal only -- never '
  'exposed through any API, no authenticated access at all.';

create index payment_webhook_events_payment_id_idx on public.payment_webhook_events (payment_id);

-- ============================================================================
-- RLS
--
-- Deliberately different from every other table in this schema: `payments`/
-- `payment_refunds` get a SELECT policy (so a booker/host/admin can safely
-- read their own payment history directly) but NO insert/update/delete
-- policy for `authenticated` at all. A row's status/amount must never be
-- directly settable by any client call, even a correctly-scoped one -- the
-- only truth sources are a provider's signed webhook and a server-side
-- status fetch. Every write goes through payment.service.ts using the
-- service-role client, with ownership/authorization checked in application
-- code first (the same way assertLocationManageable gates other modules'
-- writes) -- see docs/DATABASE.md.
--
-- payment_webhook_events gets no authenticated/anon access whatsoever.
-- ============================================================================

alter table public.payments enable row level security;
alter table public.payment_refunds enable row level security;
alter table public.payment_webhook_events enable row level security;

grant select, insert, update, delete on public.payments to service_role;
grant select, insert, update, delete on public.payment_refunds to service_role;
grant select, insert, update, delete on public.payment_webhook_events to service_role;

-- Read-only for authenticated; no grant to anon on any of the three tables
-- (payments are never public marketplace information).
grant select on public.payments to authenticated;
grant select on public.payment_refunds to authenticated;

create policy "payments_select_own_or_hosted_or_admin"
  on public.payments
  for select
  to authenticated
  using (
    exists (
      select 1 from public.bookings b
      where b.id = booking_id
        and (
          b.booker_id = auth.uid()
          or exists (select 1 from public.locations l where l.id = b.location_id and l.host_id = auth.uid())
          or public.has_role(auth.uid(), 'admin')
        )
    )
  );

create policy "payment_refunds_select_own_or_hosted_or_admin"
  on public.payment_refunds
  for select
  to authenticated
  using (
    exists (
      select 1 from public.payments p
      join public.bookings b on b.id = p.booking_id
      where p.id = payment_id
        and (
          b.booker_id = auth.uid()
          or exists (select 1 from public.locations l where l.id = b.location_id and l.host_id = auth.uid())
          or public.has_role(auth.uid(), 'admin')
        )
    )
  );

-- No policy at all for payment_webhook_events beyond the service_role grant
-- above -- RLS with zero matching policies for a role denies everything,
-- which is exactly the intent here.
