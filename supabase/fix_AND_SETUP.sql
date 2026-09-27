-- ============================================================
-- Share: очистка старых чат-таблиц + полная установка
-- ВНИМАНИЕ: удалит сообщения/диалоги. profiles по возможности оставит.
-- SQL Editor → Run целиком
-- ============================================================

create extension if not exists "pgcrypto";

-- 1) Снести старое (порядок важен)
drop table if exists public.message_reads cascade;
drop table if exists public.messages cascade;
drop table if exists public.conversation_members cascade;
drop table if exists public.conversations cascade;

-- 2) Profiles: создать или добить колонки
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text,
  display_name text not null default '',
  avatar_url text,
  last_seen timestamptz not null default now(),
  is_online boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles add column if not exists username text;
alter table public.profiles add column if not exists display_name text;
alter table public.profiles add column if not exists avatar_url text;
alter table public.profiles add column if not exists last_seen timestamptz;
alter table public.profiles add column if not exists is_online boolean;
alter table public.profiles add column if not exists created_at timestamptz;

-- дефолты на случай null
update public.profiles set display_name = coalesce(display_name, '') where display_name is null;
update public.profiles set last_seen = coalesce(last_seen, now()) where last_seen is null;
update public.profiles set is_online = coalesce(is_online, false) where is_online is null;
update public.profiles set created_at = coalesce(created_at, now()) where created_at is null;

alter table public.profiles alter column display_name set default '';
alter table public.profiles alter column display_name set not null;
alter table public.profiles alter column last_seen set default now();
alter table public.profiles alter column last_seen set not null;
alter table public.profiles alter column is_online set default false;
alter table public.profiles alter column is_online set not null;
alter table public.profiles alter column created_at set default now();
alter table public.profiles alter column created_at set not null;

-- unique username (мягко)
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'profiles_username_key'
  ) then
    begin
      alter table public.profiles add constraint profiles_username_key unique (username);
    exception when others then
      raise notice 'unique username skipped: %', SQLERRM;
    end;
  end if;
end $$;

create index if not exists profiles_username_idx on public.profiles (lower(username));
create index if not exists profiles_online_idx on public.profiles (is_online);

-- 3) Чистые таблицы чатов
create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now()
);

create table public.conversation_members (
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create index cm_user_idx on public.conversation_members (user_id);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  sender_id uuid not null references public.profiles (id) on delete cascade,
  ciphertext text not null,
  iv text not null,
  content_type text not null default 'text',
  created_at timestamptz not null default now()
);

create index messages_conv_created_idx on public.messages (conversation_id, created_at);

create table public.message_reads (
  message_id uuid not null references public.messages (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (message_id, user_id)
);

-- 4) RLS
alter table public.profiles enable row level security;
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;
alter table public.messages enable row level security;
alter table public.message_reads enable row level security;

drop policy if exists "profiles_select_all" on public.profiles;
create policy "profiles_select_all" on public.profiles
  for select to authenticated using (true);

drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own" on public.profiles
  for update to authenticated using (auth.uid() = id);

drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own" on public.profiles
  for insert to authenticated with check (auth.uid() = id);

drop policy if exists "cm_select_own" on public.conversation_members;
create policy "cm_select_own" on public.conversation_members
  for select to authenticated
  using (
    user_id = auth.uid()
    or conversation_id in (
      select cm.conversation_id from public.conversation_members cm where cm.user_id = auth.uid()
    )
  );

drop policy if exists "cm_insert" on public.conversation_members;
create policy "cm_insert" on public.conversation_members
  for insert to authenticated with check (true);

drop policy if exists "conv_select_member" on public.conversations;
create policy "conv_select_member" on public.conversations
  for select to authenticated
  using (
    id in (
      select cm.conversation_id from public.conversation_members cm where cm.user_id = auth.uid()
    )
  );

drop policy if exists "conv_insert" on public.conversations;
create policy "conv_insert" on public.conversations
  for insert to authenticated with check (true);

drop policy if exists "msg_select" on public.messages;
create policy "msg_select" on public.messages
  for select to authenticated
  using (
    conversation_id in (
      select cm.conversation_id from public.conversation_members cm where cm.user_id = auth.uid()
    )
  );

drop policy if exists "msg_insert" on public.messages;
create policy "msg_insert" on public.messages
  for insert to authenticated
  with check (
    sender_id = auth.uid()
    and conversation_id in (
      select cm.conversation_id from public.conversation_members cm where cm.user_id = auth.uid()
    )
  );

drop policy if exists "reads_select" on public.message_reads;
create policy "reads_select" on public.message_reads
  for select to authenticated
  using (
    message_id in (
      select m.id from public.messages m
      join public.conversation_members cm on cm.conversation_id = m.conversation_id
      where cm.user_id = auth.uid()
    )
  );

drop policy if exists "reads_insert" on public.message_reads;
create policy "reads_insert" on public.message_reads
  for insert to authenticated with check (user_id = auth.uid());

-- 5) Триггер
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, username, display_name, is_online, last_seen)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', 'user_' || substr(replace(new.id::text, '-', ''), 1, 8)),
    coalesce(
      new.raw_user_meta_data->>'display_name',
      coalesce(new.raw_user_meta_data->>'username', 'User')
    ),
    false,
    now()
  )
  on conflict (id) do update set
    username = excluded.username,
    display_name = excluded.display_name;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 6) Realtime
do $$
begin
  begin
    alter publication supabase_realtime add table public.messages;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.message_reads;
  exception when duplicate_object then null;
  end;
  begin
    alter publication supabase_realtime add table public.profiles;
  exception when duplicate_object then null;
  end;
end $$;

-- 7) Функции
create or replace function public.get_or_create_dm(other_user_id uuid)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  me uuid := auth.uid();
  conv_id uuid;
begin
  if me is null then
    raise exception 'not authenticated';
  end if;
  if other_user_id = me then
    raise exception 'cannot chat with self';
  end if;

  select cm1.conversation_id into conv_id
  from public.conversation_members cm1
  join public.conversation_members cm2
    on cm1.conversation_id = cm2.conversation_id
  where cm1.user_id = me and cm2.user_id = other_user_id
  limit 1;

  if conv_id is not null then
    return conv_id;
  end if;

  insert into public.conversations default values returning id into conv_id;
  insert into public.conversation_members (conversation_id, user_id) values (conv_id, me);
  insert into public.conversation_members (conversation_id, user_id) values (conv_id, other_user_id);
  return conv_id;
end;
$$;

grant execute on function public.get_or_create_dm(uuid) to authenticated;

create or replace function public.set_online(online boolean)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  update public.profiles
  set is_online = online, last_seen = now()
  where id = auth.uid();
end;
$$;

grant execute on function public.set_online(boolean) to authenticated;
