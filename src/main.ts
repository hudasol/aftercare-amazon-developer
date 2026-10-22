/**
 * Starts AFTERCARE: database, retailer sandbox, application services, the MCP
 * endpoint, the read API and the web app, all in one Node process.
 */
import type { AddressInfo } from 'node:net';
import { loadConfig } from './config.js';
import { createContainer } from './container.js';
import { interpreterFromConfig } from './infrastructure/interpreter/llm-interpreter.js';
import { createHttpApp } from './interfaces/http/app.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const interpreter = interpreterFromConfig(config);
  const container = createContainer({
    databasePath: config.DATABASE_PATH,
    demoCustomer: config.AFTERCARE_DEMO_CUSTOMER,
    caseDate: config.AFTERCARE_CASE_DATE,
    latencyMs: config.SANDBOX_LATENCY_MS,
    timeoutMs: config.SANDBOX_TIMEOUT_MS,
    ...(interpreter ? { interpreter } : {}),
  });
  if (container.migrations.length > 0) {
    console.info(`Applied migrations: ${container.migrations.join(', ')}`);
  }
  const recovered = await container.recoverInterrupted();
  if (recovered.length > 0) {
    console.warn(
      `Recovered ${recovered.length} case(s) interrupted mid-submission; they now need reconciliation.`,
    );
  }

  const app = createHttpApp(container, config);
  const server = app.listen(config.PORT, config.HOST, () => {
    const { port } = server.address() as AddressInfo;
    const base = `http://${config.HOST === '::1' ? '[::1]' : config.HOST}:${port}`;
    console.info(`AFTERCARE running at ${base}`);
    console.info(`  Assistant surface  ${base}/`);
    console.info(`  Resolution Lab     ${base}/lab`);
    console.info(`  MCP endpoint       ${base}/mcp  (Streamable HTTP, protocol 2025-11-25)`);
    console.info(`  Database           ${config.DATABASE_PATH}`);
    if (interpreter) {
      console.info(
        `  Interpreter        ${interpreter.id} (model ${config.AFTERCARE_LLM_MODEL}), falls back to rules@1`,
      );
    } else if (config.AFTERCARE_LLM_BASE_URL || config.AFTERCARE_LLM_MODEL) {
      console.warn(
        '  Model interpreter not used: set both AFTERCARE_LLM_BASE_URL and AFTERCARE_LLM_MODEL.',
      );
    }
    if (config.AFTERCARE_PUBLIC_DEMO && !config.AFTERCARE_ACCESS_TOKEN) {
      console.warn('  Public demo mode: /api and /mcp accept unauthenticated requests.');
    }
  });
  server.on('error', (error) => {
    console.error(`Could not start the server: ${error.message}`);
    process.exit(1);
  });

  const shutdown = () => {
    // Browsers hold keep-alive connections open; close them so shutdown cannot hang.
    server.close(() => {
      container.close();
      process.exit(0);
    });
    server.closeIdleConnections();
    setTimeout(() => {
      server.closeAllConnections();
      container.close();
      process.exit(0);
    }, 2000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
