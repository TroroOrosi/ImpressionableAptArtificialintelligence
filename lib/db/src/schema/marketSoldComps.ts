import { createInsertSchema } from "drizzle-zod";
import {
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { z } from "zod/v4";

export const marketSoldComps = pgTable(
  "market_sold_comps",
  {
    id: text("id").primaryKey(),
    queryKey: text("query_key").notNull(),
    title: text("title").notNull(),
    soldPrice: doublePrecision("sold_price").notNull(),
    currency: text("currency").notNull(),
    soldAt: timestamp("sold_at", { withTimezone: true }).notNull(),
    source: text("source").notNull(),
    normalizedPrice: doublePrecision("normalized_price").notNull(),
    condition: text("condition").notNull().default("unknown"),
    url: text("url").notNull(),
    feeAmount: doublePrecision("fee_amount").notNull().default(0),
    shippingAmount: doublePrecision("shipping_amount").notNull().default(0),
    identity: jsonb("identity").$type<Record<string, unknown>>().notNull(),
    evidenceHash: text("evidence_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    evidenceHashIndex: uniqueIndex("market_sold_comps_evidence_hash_idx").on(table.evidenceHash),
    queryKeyIndex: index("market_sold_comps_query_key_idx").on(table.queryKey),
    soldAtIndex: index("market_sold_comps_sold_at_idx").on(table.soldAt),
    titleIndex: index("market_sold_comps_title_idx").on(table.title),
  }),
);

export const insertMarketSoldCompSchema = createInsertSchema(marketSoldComps).omit({
  createdAt: true,
});

export type InsertMarketSoldComp = z.infer<typeof insertMarketSoldCompSchema>;
export type MarketSoldComp = typeof marketSoldComps.$inferSelect;

export const marketSoldCompsTable = marketSoldComps;