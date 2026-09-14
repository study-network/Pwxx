import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

const { Pool } = pg;

export const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl:
        process.env.DATABASE_URL?.includes("localhost") ||
        process.env.DATABASE_URL?.includes("127.0.0.1")
          ? false
          : { rejectUnauthorized: false },
    })
  : (new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === "connect") {
            return async () => ({
              query: async () => ({ rows: [], rowCount: 0 }),
              release: () => {},
            });
          }
          if (prop === "query") {
            return async () => ({ rows: [], rowCount: 0 });
          }
          return () => {};
        },
      },
    ) as any);

export const db = process.env.DATABASE_URL ? drizzle(pool, { schema }) : (null as any);

export * from "./schema";
