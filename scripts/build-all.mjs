import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

console.log("==> Building API Server...");
const apiRes = spawnSync("node", ["./build.mjs"], {
  cwd: path.resolve("artifacts/api-server"),
  stdio: "inherit",
});
if (apiRes.status !== 0) {
  console.error("API Server build failed!");
  process.exit(apiRes.status ?? 1);
}

console.log("==> Building Frontend (Vite)...");
const viteBin = fs.existsSync("artifacts/pw-clone/node_modules/.bin/vite")
  ? "./node_modules/.bin/vite"
  : "vite";

const webRes = spawnSync(viteBin, ["build", "--config", "vite.config.ts"], {
  cwd: path.resolve("artifacts/pw-clone"),
  stdio: "inherit",
  shell: true,
});
if (webRes.status !== 0) {
  console.error("Frontend build failed!");
  process.exit(webRes.status ?? 1);
}

// Copy built public frontend assets to dist/
const srcDir = path.resolve("artifacts/pw-clone/dist/public");
const destDir = path.resolve("dist");
if (fs.existsSync(srcDir)) {
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(srcDir, destDir, { recursive: true });
}

console.log("==> Build completed successfully! Both API server and Frontend are ready.");
