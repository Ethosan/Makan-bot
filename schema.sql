-- Run this in the Supabase SQL editor.
-- If you already ran the earlier version, see MIGRATION.sql instead.

create table if not exists people (
  telegram_id bigint primary key,
  display_name text not null
);

create table if not exists restaurants (
  id            bigserial primary key,
  chat_id       bigint not null,
  name          text   not null,
  tier          text   not null check (tier in ('cheap','normal','fancy')),
  visited_on    date,
  photo_file_id text,
  card_message_id bigint,
  created_at    timestamptz not null default now()
);

create unique index if not exists restaurants_chat_name_idx
  on restaurants (chat_id, lower(name));

-- Columns are nullable: a row fills in one category at a time as you tap,
-- and only counts as a finished rating once all four are set.
create table if not exists ratings (
  restaurant_id bigint not null references restaurants(id) on delete cascade,
  telegram_id   bigint not null references people(telegram_id),
  food          numeric check (food       between 1 and 10),
  ambiance      numeric check (ambiance   between 1 and 10),
  aesthetics    numeric check (aesthetics between 1 and 10),
  service       numeric check (service    between 1 and 10),
  updated_at    timestamptz not null default now(),
  primary key (restaurant_id, telegram_id)
);

-- Half-finished /add wizards. Rows are short-lived.
create table if not exists drafts (
  id                bigserial primary key,
  chat_id           bigint not null,
  thread_id         bigint,
  user_id           bigint not null,
  prompt_message_id bigint,
  panel_message_id  bigint,
  restaurant_id     bigint,
  name              text,
  tier              text,
  step              text not null,
  created_at        timestamptz not null default now()
);

create table if not exists boards (
  chat_id     bigint primary key,
  thread_id   bigint,
  message_id  bigint not null
);
