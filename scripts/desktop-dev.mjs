import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import electronPath from "electron";
import { build as buildVite, createServer } from "vite";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const typescriptCli = path.join(
  projectRoot,
  "node_modules",
  "typescript",
  "bin",
  "tsc",
);

const build = spawn(process.execPath, [typescriptCli, "-p", "tsconfig.build.json"], {
  cwd: projectRoot,
  stdio: "inherit",
  shell: false,
});
const buildExit = await new Promise((resolve, reject) => {
  build.once("error", reject);
  build.once("exit", (code) => resolve(code));
});
if (buildExit !== 0) process.exit(buildExit ?? 1);

await buildVite({
  configFile: path.join(projectRoot, "vite.preload.config.ts"),
});

const server = await createServer({
  configFile: path.join(projectRoot, "vite.desktop.config.ts"),
  server: { port: 5173 },
});
await server.listen();
const address = server.httpServer?.address();
if (!address || typeof address === "string") throw new Error("Vite development server address is unavailable.");
const developmentUrl = `http://127.0.0.1:${address.port}`;
const childEnvironment = { ...process.env };
delete childEnvironment.ELECTRON_RUN_AS_NODE;
const electron = spawn(electronPath, ["."], {
  cwd: projectRoot,
  stdio: "inherit",
  shell: false,
  env: { ...childEnvironment, EVREN_DESKTOP_DEV_URL: developmentUrl },
});

const shutdown = async () => {
  if (electron.exitCode === null) electron.kill();
  await server.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
const exitCode = await new Promise((resolve, reject) => {
  electron.once("error", reject);
  electron.once("exit", (code) => resolve(code));
});
await server.close();
process.exit(exitCode ?? 0);
