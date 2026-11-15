#!/usr/bin/env node
/**
 * Command-line runner for the association integrity guard (the Node.js mirror of workflow.json).
 *
 *   node src/index.js                 audit (demo mode while the HubSpot token is a placeholder)
 *   node src/index.js --demo          force the bundled demo dataset
 *   node src/index.js --config file   read rules (and an optional "environment" block) from a JSON file
 *   node src/index.js --json          print the full report, flag plan and Slack payload as JSON
 *   node src/index.js --fail-on-findings   exit with code 3 when orphaned or conflicting records exist
 */
import { fileURLToPath } from 'node:url';
import { loadCliContext } from './cliSupport.js';
import { runGuard } from './core/pipeline.js';
import { DEMO_NOW } from './core/demoData.js';

const HELP = `Usage: node src/index.js [--demo] [--config path/to/config.json] [--json] [--fail-on-findings]

Safety defaults: DRY_RUN=true, SANDBOX_MODE=true, FLAG_WRITES_ENABLED=false.
A placeholder HUBSPOT_PRIVATE_APP_TOKEN runs the bundled demo dataset with no network calls.`;

function printSummary({ report, flagPlan, flagResults, slack }, source, log) {
  log(`Association Integrity Guard (${report.mode} mode, rules from ${source})`);
  log(`Safety: DRY_RUN=${report.safety.dryRun} SANDBOX_MODE=${report.safety.sandboxMode} FLAG_WRITES_ENABLED=${report.safety.flagWritesEnabled}`);
  if (report.mode === 'demo') log(`Demo clock: ${DEMO_NOW}`);
  log('');
  for (const rule of report.rules) {
    log(`${rule.label} (${rule.objectTypeId}): ${rule.scanned} scanned, ${rule.evaluated} evaluated, ${rule.orphaned} orphaned, ${rule.conflict} conflicting, ${rule.atRisk} at risk, ${rule.unverified} unverified, ${rule.skippedGrace} in grace, ${rule.skippedExcluded} excluded${rule.truncated ? ' [PARTIAL: record limit reached]' : ''}${rule.circuitBreaker.tripped ? ' [CIRCUIT BREAKER]' : ''}`);
  }
  log('');
  for (const finding of report.findings.slice(0, 25)) {
    const issues = finding.violations.map((violation) => violation.code).join(', ') || 'read error';
    log(`  ${finding.status.padEnd(10)} ${finding.ruleLabel} ${finding.id}: ${issues}`);
  }
  if (report.findings.length > 25) log(`  ...${report.findings.length - 25} more`);
  if (report.cleared.length) log(`  ${report.cleared.length} previously flagged record(s) are healthy again`);
  log('');
  log(`Flags: ${flagPlan.plannedCount} planned, ${flagResults.updated} written (${flagPlan.reason})`);
  log(`Slack: ${slack.status}`);
}

export async function main(argv = process.argv.slice(2), { log = console.log, errorLog = console.error } = {}) {
  let context;
  try {
    context = loadCliContext(argv);
  } catch (error) {
    errorLog(error.message);
    return 1;
  }
  if (context.args.help) {
    log(HELP);
    return 0;
  }
  try {
    const result = await runGuard({ config: context.config, log: (line) => errorLog(line) });
    if (context.args.json) {
      log(JSON.stringify({ report: result.report, flagPlan: result.flagPlan, flagResults: result.flagResults, slack: result.slack }, null, 2));
    } else {
      printSummary(result, context.source, log);
    }
    if (context.args.failOnFindings && (result.report.totals.orphaned > 0 || result.report.totals.conflict > 0)) return 3;
    return 0;
  } catch (error) {
    errorLog(error.message);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => { process.exitCode = code; });
}
