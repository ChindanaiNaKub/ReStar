import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, rm, symlink } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { migrateDatabase } from "../../src/db/migrate";

type TestApplicationOptions = {
  environment?: Record<string, string>;
};

async function reservePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Could not reserve a test application port");
  }

  const { port } = address;
  server.close();
  await once(server, "close");
  return port;
}

export async function startTestApplication(options: TestApplicationOptions = {}) {
  const postgres = await new PostgreSqlContainer("postgres:16-alpine").start();
  const databaseUrl = postgres.getConnectionUri();
  await migrateDatabase(databaseUrl);

  const projectDir = await mkdtemp(path.join(tmpdir(), "restar-test-application-"));
  await Promise.all([
    cp(path.join(process.cwd(), "src"), path.join(projectDir, "src"), { recursive: true }),
    cp(path.join(process.cwd(), "package.json"), path.join(projectDir, "package.json")),
    cp(path.join(process.cwd(), "tsconfig.json"), path.join(projectDir, "tsconfig.json")),
    cp(path.join(process.cwd(), "next.config.ts"), path.join(projectDir, "next.config.ts")),
    symlink(path.join(process.cwd(), "node_modules"), path.join(projectDir, "node_modules"), "dir"),
  ]);

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const nextBin = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
  const server = spawn(process.execPath, [nextBin, "dev", "--webpack", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: projectDir,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      NEXT_TELEMETRY_DISABLED: "1",
      ...options.environment,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let serverOutput = "";
  server.stdout.on("data", (chunk: Buffer) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk: Buffer) => {
    serverOutput += chunk.toString();
  });

  const readyDeadline = Date.now() + 30_000;
  while (Date.now() < readyDeadline) {
    if (server.exitCode !== null) {
      await postgres.stop();
      await rm(projectDir, { recursive: true, force: true });
      throw new Error(`Test application exited before becoming ready:\n${serverOutput}`);
    }

    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) {
        return {
          request: (pathname: string, init?: RequestInit) => fetch(`${baseUrl}${pathname}`, init),
          async stop() {
            server.kill("SIGTERM");
            await Promise.race([
              once(server, "exit"),
              new Promise((resolve) => setTimeout(resolve, 5_000)),
            ]);
            if (server.exitCode === null) {
              server.kill("SIGKILL");
            }
            await postgres.stop();
            await rm(projectDir, { recursive: true, force: true });
          },
        };
      }
    } catch {
      // The server is still starting.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  server.kill("SIGKILL");
  await postgres.stop();
  await rm(projectDir, { recursive: true, force: true });
  throw new Error(`Test application did not become ready:\n${serverOutput}`);
}
