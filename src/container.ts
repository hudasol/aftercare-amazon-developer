/**
 * Composition root: wires infrastructure into the application services.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DemoService } from './application/demo-service.js';
import type { Clock, Interpreter } from './application/ports.js';
import { ResolutionService } from './application/resolution-service.js';
import { RulesInterpreter } from './infrastructure/interpreter/rules-interpreter.js';
import {
  RetailerSandbox,
  SandboxDatasetSchema,
  type SandboxDataset,
} from './infrastructure/retailer-sandbox/sandbox.js';
import { SqliteCaseRepository } from './infrastructure/sqlite/case-repository.js';
import { Database } from './infrastructure/sqlite/database.js';

export const MIGRATIONS_DIR = fileURLToPath(new URL('../migrations', import.meta.url));
export const SEED_PATH = fileURLToPath(new URL('../data/seed/retailer.json', import.meta.url));

export function loadSeedDataset(path = SEED_PATH): SandboxDataset {
  return SandboxDatasetSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export interface ContainerOptions {
  databasePath: string;
  demoCustomer: string;
  caseDate?: string | undefined;
  dataset?: SandboxDataset;
  latencyMs?: number;
  timeoutMs?: number;
  clock?: Clock;
  interpreter?: Interpreter;
}

export function createIds(): (prefix: string) => string {
  return (prefix) => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
}

export const systemClock: Clock = { now: () => new Date().toISOString() };

export function createContainer(options: ContainerOptions) {
  const db = new Database(options.databasePath);
  const migrations = db.migrate(MIGRATIONS_DIR);
  const dataset = options.dataset ?? loadSeedDataset();
  const clock = options.clock ?? systemClock;
  const repo = new SqliteCaseRepository(db);
  const sandbox = new RetailerSandbox(db, {
    clock,
    latencyMs: options.latencyMs ?? 0,
    timeoutMs: options.timeoutMs ?? 0,
  });
  const seeded = Number(
    (db.sql.prepare('SELECT COUNT(*) AS n FROM sim_orders').get() as { n: number }).n,
  );
  if (seeded === 0) sandbox.seed(dataset);

  const rules = new RulesInterpreter();
  const service = new ResolutionService({
    repo,
    gateway: sandbox,
    interpreter: options.interpreter ?? rules,
    fallbackInterpreter: rules,
    clock,
    ids: createIds(),
    caseDate: () => options.caseDate ?? dataset.caseDate,
  });
  const demo = new DemoService({
    repo,
    sandbox,
    service,
    clock,
    demoCustomer: options.demoCustomer,
    policyId: dataset.retailer.policyId,
    dataset,
  });

  return {
    db,
    repo,
    sandbox,
    service,
    demo,
    dataset,
    migrations,
    /** Move any case interrupted mid-submission to reconciliation. */
    async recoverInterrupted(): Promise<string[]> {
      const ids = repo.listCaseIdsInState('executing');
      for (const id of ids) await service.recover(id);
      return ids;
    },
    close: () => db.close(),
  };
}

export type Container = ReturnType<typeof createContainer>;
