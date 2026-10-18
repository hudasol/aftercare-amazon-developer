/**
 * Restore the demo to its known starting state: removes the demo customer's
 * cases and reseeds the simulated retailer. Other customers' data is untouched.
 */
import { loadConfig } from '../config.js';
import { createContainer } from '../container.js';

const config = loadConfig();
const container = createContainer({
  databasePath: config.DATABASE_PATH,
  demoCustomer: config.AFTERCARE_DEMO_CUSTOMER,
});
const { removedCases } = container.demo.reset();
container.close();
console.info(
  `Demo reset: removed ${removedCases} demo case(s) and reseeded the Kestrel Goods sandbox.`,
);
