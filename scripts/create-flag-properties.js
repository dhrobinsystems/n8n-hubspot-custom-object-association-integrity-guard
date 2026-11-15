#!/usr/bin/env node
/**
 * One-time setup: creates the three flag properties on every audited object that has flags enabled.
 *
 *   npm run properties:create            DRY_RUN=true (default) prints the payloads only
 *   DRY_RUN=false npm run properties:create   creates them (SANDBOX_MODE still applies)
 *
 * Set FLAG_PROPERTY_GROUP_NAME to choose the property group; otherwise the object's first group is used.
 * Properties that already exist (HTTP 409) are reported and left unchanged.
 */
import { loadCliContext, createCliHttp } from '../src/cliSupport.js';
import { enabledRules, isPlaceholder, validateGuardConfig } from '../src/core/config.js';
import { buildAccountDetailsRequest, buildFlagPropertyRequests, buildPropertyGroupsRequest, enforceSandbox } from '../src/core/hubspot.js';

export async function createFlagProperties(context, log = console.log) {
  const { config, env } = context;
  const { errors } = validateGuardConfig(config);
  if (errors.length) throw new Error(`Configuration invalid:\n- ${errors.join('\n- ')}`);
  const http = createCliHttp(config, (line) => console.error(line));
  const accountResponse = await http(buildAccountDetailsRequest(config));
  const gate = enforceSandbox(accountResponse.body, config);
  if (!gate.ok) throw new Error(gate.reason);

  const results = [];
  for (const rule of enabledRules(config)) {
    if (!rule.flag) { log(`${rule.label}: flags disabled ("flag": false), skipped`); continue; }
    let groupName = isPlaceholder(env.FLAG_PROPERTY_GROUP_NAME) ? null : String(env.FLAG_PROPERTY_GROUP_NAME).trim();
    if (!groupName) {
      const groups = await http(buildPropertyGroupsRequest(config, rule.objectTypeId));
      groupName = groups.body && groups.body.results && groups.body.results[0] ? groups.body.results[0].name : null;
      if (!groupName) throw new Error(`${rule.label}: no property group found; set FLAG_PROPERTY_GROUP_NAME`);
    }
    for (const request of buildFlagPropertyRequests(config, rule, groupName)) {
      if (config.dryRun) {
        log(`[DRY RUN] would POST ${new URL(request.url).pathname} ${JSON.stringify(request.body)}`);
        results.push({ rule: rule.key, name: request.body.name, outcome: 'planned' });
        continue;
      }
      const response = await http(request);
      const outcome = response.status === 409 ? 'already exists' : response.status >= 200 && response.status < 300 ? 'created' : `failed (${response.status})`;
      log(`${rule.label}: ${request.body.name} ${outcome}`);
      results.push({ rule: rule.key, name: request.body.name, outcome });
    }
  }
  return results;
}

if (process.argv[1] && process.argv[1].endsWith('create-flag-properties.js')) {
  createFlagProperties(loadCliContext()).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
