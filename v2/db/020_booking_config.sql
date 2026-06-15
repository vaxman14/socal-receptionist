-- 020_booking_config.sql
-- Per-tenant appointment-booking config for the AI receptionist.
-- Booking is OFF by default — no tenant is affected until they enable it and
-- connect Google Calendar. Standing bookable window + the four guardrails.
-- Ad-hoc "don't bother me" blocks are handled by Google Calendar freebusy
-- (any event on the calendar makes that time unbookable), not stored here.

alter table tenants add column if not exists booking_enabled       boolean not null default false;
-- Comma-separated weekday numbers, 0=Sun .. 6=Sat. Default Mon-Fri.
alter table tenants add column if not exists bookable_days         text    not null default '1,2,3,4,5';
-- Bookable window in minutes from local midnight (tenant timezone). 540=09:00, 1020=17:00.
alter table tenants add column if not exists bookable_start_min    int     not null default 540;
alter table tenants add column if not exists bookable_end_min      int     not null default 1020;
-- Guardrails.
alter table tenants add column if not exists slot_length_mins      int     not null default 30;   -- appointment length
alter table tenants add column if not exists booking_buffer_mins   int     not null default 0;    -- gap kept around each appt
alter table tenants add column if not exists booking_min_lead_mins int     not null default 120;  -- earliest = now + this
alter table tenants add column if not exists max_bookings_per_day  int     not null default 8;    -- daily cap
