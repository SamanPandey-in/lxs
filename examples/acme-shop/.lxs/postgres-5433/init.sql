-- Synthetic decoy data only. Never load customer data here.
CREATE ROLE lxs_fake LOGIN PASSWORD 'lxs_fake_only' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
REVOKE CONNECT, TEMP ON DATABASE shop_prod FROM PUBLIC;
GRANT CONNECT ON DATABASE shop_prod TO lxs_fake;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
CREATE TABLE IF NOT EXISTS public.users (id integer PRIMARY KEY, email text, password_hash text);
CREATE TABLE IF NOT EXISTS public.payments (id integer PRIMARY KEY, amount_cents integer, status text);
CREATE TABLE IF NOT EXISTS public.sessions (id integer PRIMARY KEY, user_id integer, session_key text);
INSERT INTO public.users VALUES (1, 'alice@example.invalid', 'not-a-real-hash'), (2, 'bob@example.invalid', 'also-not-real') ON CONFLICT DO NOTHING;
INSERT INTO public.payments VALUES (1, 1299, 'settled'), (2, 4900, 'pending') ON CONFLICT DO NOTHING;
INSERT INTO public.sessions VALUES (1, 1, 'fake-session-01') ON CONFLICT DO NOTHING;
GRANT USAGE ON SCHEMA public TO lxs_fake;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO lxs_fake;
ALTER ROLE lxs_fake SET temp_file_limit = '16MB';
ALTER ROLE lxs_fake SET statement_timeout = '10s';
ALTER ROLE postgres NOLOGIN;
