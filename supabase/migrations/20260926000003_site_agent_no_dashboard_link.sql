-- Site Agent runs only in the background (scheduled checks + Telegram): there is no
-- Site Agent page, so messages no longer end with an "Open dashboard" link.
delete from public.agent_settings where key = 'dashboard_url';
