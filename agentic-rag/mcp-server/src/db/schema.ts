import { customType, pgTable, serial, text, uniqueIndex } from "drizzle-orm/pg-core";

const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector(768)";
  },
  toDriver(value: number[]) {
    return `[${value.join(",")}]`;
  },
  fromDriver(value: string) {
    return value.slice(1, -1).split(",").map(Number);
  },
});

export const documents = pgTable(
  "documents",
  {
    id: serial("id").primaryKey(),
    source: text("source").notNull(),
    content: text("content").notNull(),
    embedding: vector("embedding").notNull(),
    // v1.5.0: stable per-chunk id, paired with source as the
    // idempotent upsert key (writer.ts). Format: `${source}:${index}`.
    chunk_id: text("chunk_id").notNull(),
  },
  (table) => ({
    sourceChunkIdIdx: uniqueIndex("documents_source_chunk_id_idx").on(
      table.source,
      table.chunk_id,
    ),
  }),
);

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;