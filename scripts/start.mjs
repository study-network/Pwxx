import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const isProduction =
  process.env.NODE_ENV === "production" ||
  process.env.RENDER === "true" ||
  process.env.ENVIRONMENT === "production";

if (isProduction) {
  const apiDist = path.resolve(process.cwd(), "artifacts/api-server/dist/index.mjs");
  
  const startApi = () => {
    const port = process.env.PORT || "8080";
    console.log(`[Production] Starting API server on port ${port}...`);
    const child = spawn("node", ["--enable-source-maps", apiDist], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => process.exit(code ?? 0));
  };

  if (!fs.existsSync(apiDist)) {
    console.log("[Production] API server dist not found, building first...");
    const buildChild = spawn("node", ["artifacts/api-server/build.mjs"], {
      stdio: "inherit",
      env: process.env,
    });
    buildChild.on("exit", (code) => {
      if (code !== 0) {
        console.error("[Production] Failed to build API server bundle!");
        process.exit(code ?? 1);
      }
      startApi();
    });
  } else {
    startApi();
  }
} else {
  // Local development mode: run start-dev.sh
  const child = spawn("bash", ["scripts/start-dev.sh"], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}
