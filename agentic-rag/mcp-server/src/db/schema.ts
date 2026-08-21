import { customType, pgTable, serial, text } from "drizzle-orm/pg-core";

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

export const documents = pgTable("documents", {
  id: serial("id").primaryKey(),
  source: text("source").notNull(),
  content: text("content").notNull(),
  embedding: vector("embedding").notNull(),
});

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;