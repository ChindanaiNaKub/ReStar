import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
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

  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const nextBin = path.join(process.cwd(), "node_modules", "next", "dist", "bin", "next");
  const server = spawn(process.execPath, [nextBin, "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: process.cwd(),
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
  throw new Error(`Test application did not become ready:\n${serverOutput}`);
}
