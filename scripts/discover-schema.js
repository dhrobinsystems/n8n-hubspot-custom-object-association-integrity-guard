#!/usr/bin/env node
/**
 * Read-only discovery: lists custom object type IDs and the association labels (typeId + category)
 * between each audited object and its parent types, so config.json can be filled in without guessing.
 *
 *   npm run discover                 uses config.json / GUARD_CONFIG_JSON for the object pairs
 *   npm run discover -- --json       machine-readable output
 *
 * SANDBOX_MODE=true (default) refuses non-sandbox portals here as well.
 */
import { loadCliContext, createCliHttp } from '../src/cliSupport.js';
import { enabledRules, isPlaceholder, isValidObjectType } from '../src/core/config.js';
import { buildAccountDetailsRequest, buildAssociationLabelsRequest, buildSchemasRequest, enforceSandbox } from '../src/core/hubspot.js';

const DEFAULT_PARENTS = ['companies', 'deals'];

async function getJson(http, request) {
  const response = await http(request);
  if (response.status < 200 || response.status >= 300) throw new Error(`HubSpot ${request.method} ${new URL(request.url).pathname} returned ${response.status}`);
  return response.body;
}

export async function discover(context, log = console.log) {
  const { config } = context;
  const http = createCliHttp(config, (line) => console.error(line));
  const account = await getJson(http, buildAccountDetailsRequest(config));
  const gate = enforceSandbox(account, config);
  if (!gate.ok) throw new Error(gate.reason);

  const schemas = (await getJson(http, buildSchemasRequest(config))).results || [];
  const configured = enabledRules(config).filter((rule) => !isPlaceholder(rule.objectTypeId) && isValidObjectType(rule.objectTypeId));
  const pairs = [];
  if (configured.length) {
    for (const rule of configured) for (const toObjectType of new Set(rule.requirements.map((requirement) => requirement.toObjectType))) {
      if (!isPlaceholder(toObjectType)) pairs.push([rule.objectTypeId, toObjectType]);
    }
  } else {
    for (const schema of schemas) for (const parent of DEFAULT_PARENTS) pairs.push([schema.objectTypeId, parent]);
  }

  const labels = [];
  for (const [fromObjectType, toObjectType] of pairs) {
    const results = (await getJson(http, buildAssociationLabelsRequest(config, fromObjectType, toObjectType))).results || [];
    labels.push({ fromObjectType, toObjectType, labels: results.map((entry) => ({ typeId: entry.typeId, category: entry.category, label: entry.label ?? null })) });
  }

  const output = {
    mode: config.mode,
    portal: { portalId: gate.portalId, accountType: gate.accountType },
    customObjects: schemas.map((schema) => ({ objectTypeId: schema.objectTypeId, name: schema.name, fullyQualifiedName: schema.fullyQualifiedName, singular: schema.labels && schema.labels.singular, plural: schema.labels && schema.labels.plural })),
    associationLabels: labels,
  };
  if (context.args.json) {
    log(JSON.stringify(output, null, 2));
    return output;
  }
  log(`Portal ${gate.portalId} (${gate.accountType || 'unknown type'})${config.mode === 'demo' ? ' [demo data]' : ''}`);
  log('\nCustom objects');
  for (const schema of output.customObjects) log(`  ${schema.objectTypeId.padEnd(14)} ${schema.plural || schema.name} (${schema.fullyQualifiedName || schema.name})`);
  log('\nAssociation labels (use typeId + category in config.json)');
  for (const pair of labels) {
    log(`  ${pair.fromObjectType} -> ${pair.toObjectType}`);
    if (!pair.labels.length) log('    (no association definitions returned)');
    for (const label of pair.labels) log(`    typeId ${String(label.typeId).padEnd(6)} ${label.category.padEnd(18)} ${label.label || '(unlabeled default)'}`);
  }
  return output;
}

if (process.argv[1] && process.argv[1].endsWith('discover-schema.js')) {
  discover(loadCliContext()).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
