import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

const validLogLevels = new Set(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);
const envLogLevel = process.env.LOG_LEVEL?.trim().toLowerCase();
const resolvedLogLevel = envLogLevel && validLogLevels.has(envLogLevel) ? envLogLevel : "info";

export const logger = pino({
  level: resolvedLogLevel,
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
