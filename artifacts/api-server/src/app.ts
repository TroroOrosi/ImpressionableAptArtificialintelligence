import express, { type Express, type ErrorRequestHandler } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

// Body-parser failures precede the MCP router. Return protocol errors, not HTML or raw exceptions.
const mcpParseErrors: ErrorRequestHandler = (error: unknown, req, res, next) => {
  if (req.path !== "/api/mcp") { next(error); return; }
  const type = error && typeof error === "object" && "type" in error ? error.type : undefined;
  const tooLarge = type === "entity.too.large";
  const malformed = type === "entity.parse.failed";
  res.setHeader("Cache-Control", "no-store");
  res.status(tooLarge ? 413 : malformed ? 400 : 500).json({
    jsonrpc: "2.0", id: null,
    error: { code: malformed ? -32700 : -32603, message: tooLarge ? "Request body too large" : malformed ? "Parse error" : "Internal error" },
  });
};
app.use(mcpParseErrors);

export default app;
