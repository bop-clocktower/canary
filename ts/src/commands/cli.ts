/**
 * The sub-app registration barrel for `canary` (#988).
 *
 * `ts/src/cli.ts` used to import every sub-app builder directly, so each new
 * subcommand added one import and the file crossed the perf gate's
 * import-count threshold on the shape rather than on a defect. It now imports
 * this one module instead: add a new sub-app builder HERE, and register it with
 * `program.addCommand(...)` in `cli.ts`.
 *
 * The path is deliberate. `commands/cli.ts` sits in the `cli` arch layer
 * (`ts/src/**\/*cli*.ts`) and under the reviewed `coupling` /
 * `ts/src/**\/cli.ts` perf allowance: a barrel is a coupling ratio of 1.00 by
 * definition, and a name outside that glob would trade the import-count
 * finding for a new coupling one.
 */

export { createAnalyzeCommand } from '../analysis/cli.js';
export { buildBatwomanCommand } from '../batwoman-cli.js';
export { buildBriefingCommand } from '../briefing/briefing-cli.js';
export { buildOrderCommand } from '../order/order-cli.js';
export { buildRewindCommand } from '../rewind/rewind-cli.js';
export { buildCiReadyCommand } from '../ci-ready-cli.js';
export { buildInventoryCommand } from '../inventory/inventory-cli.js';
export { buildGenDataCommand } from '../gen-data/gen-data-cli.js';
export { buildScalingCurveCommand } from '../scaling-curve-cli.js';
export { buildPermissionMatrixCommand } from '../permission-matrix-cli.js';
export { buildCompanyKnowledgeCommand } from '../company-knowledge-cli.js';
export { createGuardianCommand } from '../guardian/cli.js';
export { createHistoryCommand } from '../history/cli.js';
export { buildSkillsCommand } from '../skills-cli.js';
export { buildWorkflowCommand } from '../workflow-cli.js';
