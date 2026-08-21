import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

const { Pool } = pg;

const connectionString =
  process.env.DATABASE_URL ?? "postgres://rag:rag@localhost:5432/rag";

export const pool = new Pool({ connectionString, max: 5 });
export const db = drizzle(pool, { schema });
export { schema };