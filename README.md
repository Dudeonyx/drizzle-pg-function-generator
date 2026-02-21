Mostly did this cus I have a ton of postgres functions due to supabase heavily relying on them for any complex queries.
And the only reason I am even sharing this is to maybe help some else switching to drizzle from pure supabase, can't say I'm happy sharing AI code otherwise.

Anyway it's [here](https://github.com/Dudeonyx/drizzle-pg-function-generator/blob/a38dec37752a90eec396ff586971ad9b30fe345f/generate-db-functions.ts)

Again this was mostly coded with AI so don't use in prod unless you fully audit and extensively test the code yourself

Sample output
```ts
// AUTO-GENERATED FILE — do not edit manually.
// Regenerate with: bun scripts/generate-db-functions.ts
// Generated at: 2026-02-21T18:49:30.935Z

import { sql } from 'drizzle-orm';
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js';

type AnyPgDb = PostgresJsDatabase<Record<string, unknown>>;

// ── get_transaction_history ─────────────────────────────────────

export type GetTransactionHistoryArgs = {
  p_limit?: number;
  p_offset?: number;
  p_type?: string;
}

export type GetTransactionHistoryRow = {
  txn_id: string;
  amount: string;
  transaction_type: string;
  transaction_category: string;
  description: string;
  metadata: Json;
  created_at: string;
  reversed: boolean;
}

export async function getTransactionHistory<T extends AnyPgDb>(db: T, args: GetTransactionHistoryArgs) {
  return db.execute<GetTransactionHistoryRow>(sql`SELECT * FROM public.get_transaction_history(${args.p_limit ?? null}, ${args.p_offset ?? null}, ${args.p_type ?? null})`);
}


// ── get_user_activity ───────────────────────────────────────────

export type GetUserActivityArgs = {
  p_limit?: string;
}

export type GetUserActivityRow = {
  user_id: number;
  email: string;
  transactions_count: string;
  total_volume: string;
  last_seen: string;
}

export async function getUserActivity<T extends AnyPgDb>(db: T, args: GetUserActivityArgs) {
  return db.execute<GetUserActivityRow>(sql`SELECT * FROM public.get_user_activity(${args.p_limit ?? null})`);
}
```

SAMPLE USAGE

```ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '../drizzle/schema';
import { sql } from 'drizzle-orm';
import { getTransactionHistory } from '@/drizzle/db-functions.generated';

const connectionString = process.env.DATABASE_URL ?? '';

const client = postgres(connectionString, { prepare: false });
export const db = drizzle({ client, schema: { schema} });


// use the db client directly
const transactionHistory = await getTransactionHistory(db, { p_limit: 20, p_offset: 0 });

// OR

// use in a transaction
const transactionHistory = await db.transaction(async (tx) => {
    const result = await getTransactionHistory(tx, { p_limit: 20, p_offset: 0 });
    return result;
  });

```
