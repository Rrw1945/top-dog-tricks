import pg from "pg";

export async function normalizeSubscriberEmails(client) {
  await client.query("begin");
  try {
    await client.query(
      "lock table subscribers, spotlight_notifications in share row exclusive mode",
    );
    await client.query(`
      create temporary table subscriber_canonical_map on commit drop as
      with ranked as (
        select
          id,
          lower(trim(email)) as canonical_email,
          first_value(id) over (
            partition by lower(trim(email))
            order by
              (verified_at is not null and unsubscribed_at is null) desc,
              (verified_at is not null) desc,
              created_at,
              id
          ) as keeper_id
        from subscribers
      )
      select id, canonical_email, keeper_id
      from ranked
    `);
    await client.query(`
      with ranked_notifications as (
        select
          notification.id,
          row_number() over (
            partition by notification.submission_id, mapping.canonical_email
            order by
              case notification.status
                when 'delivered' then 1
                when 'claimed' then 2
                when 'failed' then 3
                else 4
              end,
              notification.delivered_at desc nulls last,
              notification.claimed_at desc,
              notification.id
          ) as canonical_rank
        from spotlight_notifications notification
        inner join subscriber_canonical_map mapping
          on mapping.id = notification.subscriber_id
      )
      delete from spotlight_notifications notification
      using ranked_notifications ranked
      where notification.id = ranked.id
        and ranked.canonical_rank > 1
    `);
    await client.query(`
      update spotlight_notifications notification
      set subscriber_id = mapping.keeper_id
      from subscriber_canonical_map mapping
      where notification.subscriber_id = mapping.id
        and mapping.id <> mapping.keeper_id
    `);
    await client.query(`
      create temporary table subscriber_canonical_state on commit drop as
      select
        mapping.keeper_id,
        mapping.canonical_email,
        bool_or(subscriber.verified_at is not null and subscriber.unsubscribed_at is null) as has_active,
        max(subscriber.verified_at) as verified_at,
        max(subscriber.unsubscribed_at) as unsubscribed_at
      from subscriber_canonical_map mapping
      inner join subscribers subscriber on subscriber.id = mapping.id
      group by mapping.keeper_id, mapping.canonical_email
    `);
    await client.query(`
      delete from subscribers subscriber
      using subscriber_canonical_map mapping
      where subscriber.id = mapping.id
        and mapping.id <> mapping.keeper_id
    `);
    await client.query(`
      update subscribers keeper
      set
        email = state.canonical_email,
        verified_at = state.verified_at,
        unsubscribed_at = case when state.has_active then null else state.unsubscribed_at end,
        verification_token_hash = case
          when state.verified_at is not null then null
          else keeper.verification_token_hash
        end,
        updated_at = now()
      from subscriber_canonical_state state
      where keeper.id = state.keeper_id
    `);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL, ensure the database is provisioned");
  }
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  try {
    await normalizeSubscriberEmails(client);
  } finally {
    client.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href) {
  await main();
}