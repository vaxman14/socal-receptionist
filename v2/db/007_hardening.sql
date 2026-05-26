-- 007_hardening.sql — security + correctness fixes from audit
-- Run in Supabase SQL Editor.

-- #5: One tenant per user. Partial index allows NULL owner_user_id
-- (e.g. manually seeded demo tenants without an owner account).
create unique index if not exists tenants_owner_user_id_unique
  on tenants (owner_user_id)
  where owner_user_id is not null;

-- #7: Atomic job claim using FOR UPDATE SKIP LOCKED — safe for multiple workers.
create or replace function claim_provisioning_jobs(p_limit int default 5)
returns setof provisioning_jobs
language sql
as $$
  update provisioning_jobs
  set status = 'running', attempts = attempts + 1
  where id in (
    select id from provisioning_jobs
    where status = 'pending'
      and run_after <= now()
    order by run_after
    limit p_limit
    for update skip locked
  )
  returning *;
$$;

-- #8: Atomic contract publish — clears old current and sets new one in one
-- transaction so there is never a window with zero current contracts.
create or replace function publish_contract_version(p_id uuid)
returns contract_versions
language plpgsql
as $$
declare
  v_result contract_versions;
begin
  update contract_versions set is_current = false where is_current = true and id <> p_id;
  update contract_versions
    set is_current = true, published_at = now()
    where id = p_id
    returning * into v_result;
  if v_result is null then
    raise exception 'contract version not found: %', p_id;
  end if;
  return v_result;
end;
$$;
