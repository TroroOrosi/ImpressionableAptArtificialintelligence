import { createInsertSchema } from "drizzle-zod";
import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const marketSourceHealth = pgTable(
  "market_source_health",
  {
    providerId: text("provider_id").primaryKey(),
    attempts: integer("attempts").notNull().default(0),
    successes: integer("successes").notNull().default(0),
    failures: integer("failures").notNull().default(0),
    observations: integer("observations").notNull().default(0),
    lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
    lastError: text("last_error"),
    lastLatencyMs: integer("last_latency_ms").notNull().default(0),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    updatedAtIndex: index("market_source_health_updated_at_idx").on(table.updatedAt),
  }),
);

export const insertMarketSourceHealthSchema = createInsertSchema(marketSourceHealth).omit({
  updatedAt: true,
});

export type InsertMarketSourceHealth = z.infer<typeof insertMarketSourceHealthSchema>;
export type MarketSourceHealth = typeof marketSourceHealth.$inferSelect;

export const marketSourceHealthTable = marketSourceHealth;