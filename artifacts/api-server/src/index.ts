import app from "./app";
import { logger } from "./lib/logger";
import { getSoldCompRecencyWarning } from "./market/core";
import { cleanupMarketHistory } from "./market/storage";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);
const historyCleanupIntervalMs = 24 * 60 * 60 * 1_000;

function startHistoryCleanup() {
  const runCleanup = () => {
    void cleanupMarketHistory().then((result) => {
      if (result.status === "unavailable") {
        logger.debug("Market history cleanup skipped because persistence is unavailable");
      }
    }).catch((error: unknown) => {
      logger.error({ err: error }, "Market history cleanup failed");
    });
  };

  runCleanup();
  const timer = setInterval(runCleanup, historyCleanupIntervalMs);
  timer.unref();
}

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

const soldCompRecencyWarning = getSoldCompRecencyWarning();
if (soldCompRecencyWarning) {
  const { message, ...warningFields } = soldCompRecencyWarning;
  logger.warn(warningFields, message);
}

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");
  startHistoryCleanup();
});
