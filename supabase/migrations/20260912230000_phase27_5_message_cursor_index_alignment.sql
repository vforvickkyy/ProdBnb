-- Phase 27-5: Messaging cursor index alignment
--
-- One `create or replace function`. Nothing else: no table, column, index,
-- trigger, policy or grant changes, and no change to the function's signature,
-- return type, security mode, ordering, limit behaviour or results. The
-- Phase 27-1/27-2/27-3/27-4 migrations are untouched.
--
-- ============================================================================
-- THE MEASURED PROBLEM
--
-- Phase 27-4 shipped message history as keyset pagination over the existing
-- `messages_conversation_id_created_at_id_idx (conversation_id, created_at
-- desc, id desc)`. The predicate was written in the conventional expanded
-- form:
--
--     _cursor_created_at is null
--     or m.created_at < _cursor_created_at
--     or (m.created_at = _cursor_created_at and m.id < _cursor_id)
--
-- That is logically correct, and it was measured to be correct. What it is
-- NOT is keyset-efficient: PostgreSQL cannot turn an OR-chain into an index
-- range start condition, so it lands in `Filter` and the scan begins at the
-- newest message and DISCARDS everything down to the cursor. Measured on a
-- 5,000-message conversation at a 4,000-row-deep cursor:
--
--     Index Cond: (conversation_id = $1)
--     Filter:     ((created_at < $2) OR ((created_at = $2) AND (id < $3)))
--     Rows Removed by Filter: 4001
--     Buffers: shared hit=86        (first page for comparison: 3)
--
-- That is O(offset) -- precisely the behaviour keyset pagination exists to
-- eliminate. It is harmless at today's volumes and grows linearly with
-- conversation length.
--
-- ============================================================================
-- WHY THE OBVIOUS FIX DOES NOT WORK
--
-- The natural rewrite keeps the null guard and swaps the OR-chain for a row
-- comparison:
--
--     _cursor_created_at is null or (m.created_at, m.id) < (_cursor_created_at, _cursor_id)
--
-- With literal values that plans beautifully -- the planner constant-folds
-- `'...'::timestamptz is null` to false, drops the branch, and produces an
-- Index Cond. It is a trap. PostgREST invokes this function with real
-- PARAMETERS, so the plan that matters is the generic one, where `$2` is not
-- known at plan time and the branch cannot be folded away. Measured under
-- `plan_cache_mode = force_generic_plan`:
--
--     Filter: (($2 IS NULL) OR (ROW(created_at, id) < ROW($2, $3)))
--     Rows Removed by Filter: 4001
--     Buffers: shared hit=85        -- i.e. no better than before
--
-- ============================================================================
-- THE FIX
--
-- Remove the branch entirely by folding the null case into the comparison
-- itself, using sentinels that are the maximum of each type. There is then a
-- single unconditional row comparison, which the planner can push into the
-- index in both the cursor and no-cursor cases. Measured, same generic plan:
--
--     Index Cond: ((conversation_id = $1) AND (ROW(created_at, id)
--                  < ROW(COALESCE($2, 'infinity'), COALESCE($3, 'ffff...'))))
--     Rows Removed by Filter: (none)
--     Buffers: shared hit=4         -- deep cursor
--     Buffers: shared hit=3         -- first page (null cursor)
--
-- The sentinels are load-bearing, not decoration:
--   * 'infinity'::timestamptz is greater than every real timestamptz, so a
--     null cursor compares as "older than everything" -> the first page.
--   * 'ffffffff-ffff-ffff-ffff-ffffffffffff' is the maximum uuid, needed for
--     the same reason on the tiebreak column.
-- Both are only ever reached when the corresponding parameter is null, which
-- the service layer only does for the first page.
--
-- SEMANTICS ARE UNCHANGED. Row comparison `(a, b) < (c, d)` is defined as
-- `a < c or (a = c and b < d)`, which is exactly the predicate it replaces --
-- and both operands are NOT NULL columns, so no three-valued-logic difference
-- can arise. Verified directly against the old predicate on a 5,000-message
-- fixture: IDENTICAL ROW SETS, first page, mid page, across a timestamp tie,
-- past the end, and on an empty conversation.
--
-- The cursor WIRE FORMAT is untouched -- this is an internal plan-shape fix
-- with no API, DTO or client-visible change of any kind. Cursors minted
-- before this migration keep working.
-- ============================================================================

create or replace function public.get_conversation_messages(
  _conversation_id uuid,
  _cursor_created_at timestamptz default null,
  _cursor_id uuid default null,
  _limit integer default 50
)
returns table (
  id uuid,
  conversation_id uuid,
  sender_id uuid,
  body text,
  client_message_id uuid,
  created_at timestamptz
)
language sql
security invoker
stable
set search_path = public
as $$
  select m.id, m.conversation_id, m.sender_id, m.body, m.client_message_id, m.created_at
  from public.messages m
  where m.conversation_id = _conversation_id
    -- Keyset predicate for (created_at desc, id desc), written as a single
    -- unconditional row comparison so it can serve as an index range start
    -- condition under a generic parameterized plan. See the header for the
    -- measurements, and for why the `_cursor_created_at is null or ...` form
    -- silently loses that property.
    and (m.created_at, m.id) < (
          coalesce(_cursor_created_at, 'infinity'::timestamptz),
          coalesce(_cursor_id, 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid)
        )
  order by m.created_at desc, m.id desc
  -- Unchanged from Phase 27-4. Hard ceiling of 101, not 100: the user-facing
  -- maximum of 100 is enforced in messaging.schema.ts, while the service asks
  -- for `limit + 1` rows to detect has_more without a second query. This clamp
  -- is the defensive backstop for a direct RPC caller, not the product limit.
  limit greatest(least(coalesce(_limit, 50), 101), 1);
$$;

comment on function public.get_conversation_messages(uuid, timestamptz, uuid, integer) is
  'Keyset-paginated message history for one conversation, newest first. '
  'SECURITY INVOKER -- messages_select_participant does the authorizing, so '
  'this function grants no access of its own and has no admin branch. The '
  'cursor predicate is a single row comparison with COALESCE sentinels '
  '(Phase 27-5) so that PostgreSQL can use it as an index range condition on '
  'messages_conversation_id_created_at_id_idx under a generic parameterized '
  'plan; the equivalent OR-chain becomes a Filter and rescans from the newest '
  'message. Adds no index.';

-- Privileges are deliberately NOT re-stated. `create or replace function`
-- preserves the existing grants, so the Phase 27-4 posture carries over
-- unchanged: EXECUTE revoked from PUBLIC, granted to authenticated and
-- service_role only. Re-issuing them here would imply this migration changes
-- them, which it must not.
