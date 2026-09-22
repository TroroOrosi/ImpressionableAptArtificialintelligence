import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { dirname, join } from "node:path";

const fixtureScript = fileURLToPath(new URL("./persistence-fixture.ts", import.meta.url));
const apiServerRoot = join(dirname(fixtureScript), "../..");

function quoteIdentifier(value: string) {
  return `"${value.replaceAll(`"`, `""`)}"`;
}

function databaseUrlFor(databaseName: string) {
  const url = new URL(process.env.DATABASE_URL || "");
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function runFixture(
  mode: "setup" | "write" | "write-mixed-market" | "cleanup" | "read" | "read-mixed-market",
  databaseUrl: string,
  marker: string,
) {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", fixtureScript, mode],
    {
      cwd: apiServerRoot,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        MARKET_TEST_MARKER: marker,
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

function parseFixtureJson(output: string) {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index] as string) as Record<string, unknown>;
    } catch {
      // Structured logger output may precede the fixture's JSON payload.
    }
  }
  throw new Error(`Fixture did not emit JSON: ${output}`);
}

test("market records survive a fresh storage and core instance", {
  concurrency: false,
  skip: !process.env.DATABASE_URL,
}, async () => {
  const { pool } = await import("@workspace/db");
  const marker = `market_restart_${process.pid}_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const databaseName = `${marker}_db`;
  let databaseCreated = false;

  try {
    await pool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    const databaseUrl = databaseUrlFor(databaseName);

    runFixture("setup", databaseUrl, marker);
    runFixture("write", databaseUrl, marker);
    const cleanup = parseFixtureJson(runFixture("cleanup", databaseUrl, marker)) as {
      status: string;
      observationsDeleted: number;
      soldCompsDeleted: number;
      observationsRemaining: boolean;
      soldCompsRemaining: boolean;
    };
    assert.equal(cleanup.status, "completed");
    assert.equal(cleanup.observationsDeleted, 1);
    assert.equal(cleanup.soldCompsDeleted, 1);
    assert.equal(cleanup.observationsRemaining, false);
    assert.equal(cleanup.soldCompsRemaining, false);

    const persisted = JSON.parse(runFixture("read", databaseUrl, marker)) as {
      history: Array<Record<string, unknown>>;
      soldComps: Array<Record<string, unknown>>;
      persistedHealth: Record<string, unknown> | undefined;
      coreHealth: Record<string, unknown>;
    };

    assert.equal(persisted.history.length, 1);
    assert.equal(persisted.history[0]?.id, `${marker}-observation`);
    assert.equal(persisted.history[0]?.currency, "JPY");
    assert.equal(persisted.history[0]?.freshness_seconds, 42);
    assert.deepEqual(persisted.history[0]?.identity, {
      model: marker,
      accessories: ["strap"],
    });

    assert.equal(persisted.soldComps.length, 1);
    assert.equal(persisted.soldComps[0]?.sold_price, 100);
    assert.equal(persisted.soldComps[0]?.currency, "USD");
    assert.equal(persisted.soldComps[0]?.normalized_price, 12750);
    assert.equal(persisted.soldComps[0]?.condition, "new");
    assert.deepEqual(persisted.soldComps[0]?.identity, {
      model: marker,
      accessories: ["strap"],
    });

    assert.deepEqual(persisted.persistedHealth, {
      attempts: 1,
      successes: 0,
      failures: 1,
      observations: 2,
      lastSuccessAt: null,
      lastError: "timeout",
      lastLatencyMs: 123,
      consecutiveFailures: 1,
    });
    assert.deepEqual(persisted.coreHealth, {
      attempts: 1,
      successes: 0,
      failures: 1,
      observations: 2,
      lastSuccessAt: null,
      lastError: "timeout",
      lastErrorType: "timeout",
      lastLatencyMs: 123,
      consecutiveFailures: 1,
    });
  } finally {
    if (databaseCreated) {
      await pool.query(`DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    }
  }
});

test("stored sold comps filter sources before applying the limit", {
  concurrency: false,
  skip: !process.env.DATABASE_URL,
}, async () => {
  const { pool } = await import("@workspace/db");
  const marker = `market_mixed_${process.pid}_${Date.now()}_${randomUUID().replaceAll("-", "").slice(0, 8)}`;
  const databaseName = `${marker}_db`;
  let databaseCreated = false;

  try {
    await pool.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    databaseCreated = true;
    const databaseUrl = databaseUrlFor(databaseName);

    runFixture("setup", databaseUrl, marker);
    runFixture("write-mixed-market", databaseUrl, marker);
    const persisted = parseFixtureJson(runFixture("read-mixed-market", databaseUrl, marker)) as {
      filtered: Array<Record<string, unknown>>;
      filteredStatus: string;
      merged: Array<Record<string, unknown>>;
      mergedStatus: string;
    };

    assert.equal(persisted.filteredStatus, "available");
    assert.deepEqual(persisted.filtered.map((comp) => comp.source), ["ebay"]);
    assert.equal(persisted.filtered[0]?.title, `Mixed market ${marker} ebay-older`);

    assert.equal(persisted.mergedStatus, "available");
    assert.deepEqual(persisted.merged.map((comp) => comp.source), [
      "stockx",
      "stockx",
      "ebay",
      "ebay",
    ]);
  } finally {
    if (databaseCreated) {
      await pool.query(`DROP DATABASE ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    }
  }
});

test.after(async () => {
  if (!process.env.DATABASE_URL) return;
  const { pool } = await import("@workspace/db");
  await pool.end();
});