import { createInsertSchema } from "drizzle-zod";
import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const marketObservations = pgTable(
  "market_observations",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    value: doublePrecision("value").notNull(),
    currency: text("currency").notNull(),
    source: text("source").notNull(),
    sourceTier: integer("source_tier").notNull(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
    freshnessSeconds: integer("freshness_seconds").notNull(),
    remainingSeconds: integer("remaining_seconds"),
    confidence: doublePrecision("confidence").notNull(),
    url: text("url").notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    identity: jsonb("identity").$type<Record<string, unknown>>().notNull(),
    actionable: boolean("actionable").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    evidenceHashIndex: uniqueIndex("market_observations_evidence_hash_idx").on(table.evidenceHash),
    fetchedAtIndex: index("market_observations_fetched_at_idx").on(table.fetchedAt),
    titleIndex: index("market_observations_title_idx").on(table.title),
  }),
);

export const insertMarketObservationSchema = createInsertSchema(marketObservations).omit({
  createdAt: true,
});

export type InsertMarketObservation = z.infer<typeof insertMarketObservationSchema>;
export type MarketObservation = typeof marketObservations.$inferSelect;

// Keep the table name discoverable for callers that prefer the conventional *Table suffix.
export const marketObservationsTable = marketObservations;