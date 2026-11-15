import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  isPlaceholder, loadGuardConfig, readBooleanEnv, resolveSlackTarget, validateGuardConfig,
} from '../src/core/config.js';
import {
  auditDataset, classifyRecord, describeViolation, evaluateRequirement, planFlagUpdates, statusFromViolations,
} from '../src/core/integrity.js';
import {
  assembleDataset, assertStageComplete, buildFlagUpdateRequests, enforceSandbox, planRecordFetch, recordUrl,
  summarizeAccount, tagAssociationResponse, tagTargetResponse,
} from '../src/core/hubspot.js';
import { buildFailureAlert, buildSlackAlert, redactSecrets, shouldAlert } from '../src/core/slack.js';
import { createDemoState, DEMO_GUARD_DOCUMENT, DEMO_NOW, loadDemoConfig } from '../src/core/demoData.js';
import { createMockHubSpot } from '../src/core/mockHubSpot.js';
import { runAudit, runDemoAudit, runGuard, createHubSpotHttp } from '../src/core/pipeline.js';
import { parseDotEnv } from '../src/cliSupport.js';

const NOW = Date.parse(DEMO_NOW);
const TOKEN = 'test-token-not-a-real-credential';
const SANDBOX_HOOK = 'https://hooks.slack.com/services/EXAMPLE/SANDBOX/EXAMPLE';
const PROD_HOOK = 'https://hooks.slack.com/services/EXAMPLE/PRODUCTION/EXAMPLE';

function hubspotEnv(extra = {}) {
  return { HUBSPOT_PRIVATE_APP_TOKEN: TOKEN, GUARD_CONFIG_JSON: JSON.stringify(DEMO_GUARD_DOCUMENT), AUDIT_NOW: DEMO_NOW, ...extra };
}

function requirement(overrides = {}) {
  return { key: 'company', label: 'Company', toObjectType: 'companies', associationTypeId: null, associationCategory: null, associationLabel: null, min: 1, max: null, severity: 'critical', when: [], targetWhen: [], verifyTargets: false, ...overrides };
}

const RECORD = { id: '1', createdAt: '2026-01-01T00:00:00.000Z', properties: { stage: 'active' } };

/* ---------- configuration and safety switches ---------- */

test('boolean switches only change on explicit words and keep the safe fallback otherwise', () => {
  assert.equal(readBooleanEnv(undefined, true), true);
  assert.equal(readBooleanEnv('', true), true);
  assert.equal(readBooleanEnv('flase', true), true);
  assert.equal(readBooleanEnv('OFF', true), false);
  assert.equal(readBooleanEnv('0', true), false);
  assert.equal(readBooleanEnv('maybe', false), false);
  assert.equal(readBooleanEnv('Yes', false), true);
});

test('placeholders are detected, including ones embedded in URLs', () => {
  for (const value of ['', '   ', 'YOUR_HUBSPOT_PRIVATE_APP_TOKEN_HERE', 'your_token_here', 'changeme', 'xxxx', 'https://hooks.slack.com/services/YOUR_SLACK_WEBHOOK_PATH_HERE', null, undefined]) {
    assert.equal(isPlaceholder(value), true, String(value));
  }
  assert.equal(isPlaceholder(TOKEN), false);
});

test('an empty environment is demo mode with every safety switch on', () => {
  const config = loadGuardConfig({});
  assert.equal(config.mode, 'demo');
  assert.equal(config.dryRun, true);
  assert.equal(config.sandboxMode, true);
  assert.equal(config.flagWritesEnabled, false);
  assert.deepEqual(validateGuardConfig(config).errors, []);
  assert.equal(resolveSlackTarget(config).target, 'preview');
});

test('live mode refuses to start with a placeholder token', () => {
  const { errors } = validateGuardConfig(loadGuardConfig({ DRY_RUN: 'false', SANDBOX_MODE: 'false' }));
  assert.match(errors.join('\n'), /needs a real HUBSPOT_PRIVATE_APP_TOKEN/);
});

test('hubspot mode without GUARD_CONFIG_JSON is an error', () => {
  const { errors } = validateGuardConfig(loadGuardConfig({ HUBSPOT_PRIVATE_APP_TOKEN: TOKEN }));
  assert.match(errors.join('\n'), /GUARD_CONFIG_JSON is missing/);
});

test('config.example.json is structurally valid and every placeholder blocks a HubSpot run', () => {
  const document = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  const config = loadGuardConfig({ HUBSPOT_PRIVATE_APP_TOKEN: TOKEN }, { guardDocument: document });
  assert.deepEqual(config.problems, []);
  assert.equal(config.rules.length, 3);
  const { errors } = validateGuardConfig(config);
  assert.ok(errors.some((error) => /projects": objectTypeId is still a placeholder/.test(error)));
  assert.ok(errors.some((error) => /primary_company": associationTypeId is still a placeholder/.test(error)));
  assert.ok(errors.some((error) => /skipWhen: property name is still a placeholder/.test(error)));
  for (const value of Object.values(document.environment)) {
    assert.ok(isPlaceholder(value) || ['true', 'false', '10', 'https://api.hubapi.com'].includes(value), `unexpected environment value ${value}`);
  }
});

test('structural mistakes in rules are reported', () => {
  const config = loadGuardConfig({ HUBSPOT_PRIVATE_APP_TOKEN: TOKEN }, {
    guardDocument: {
      associationTypes: { wrong: { fromObjectType: '2-999', toObjectType: 'companies', typeId: 5 } },
      rules: [{
        key: 'a',
        objectTypeId: '2-123',
        requirements: [
          { toObjectType: 'companies', min: 3, max: 1 },
          { toObjectType: 'deals', associationType: 'missing' },
          { toObjectType: 'companies', associationType: 'wrong', severity: 'fatal' },
          { toObjectType: 'deals', min: 0 },
          { toObjectType: 'deals', when: [{ property: 'x', in: ['a'], notIn: ['b'] }] },
        ],
      }],
    },
  });
  const text = config.problems.join('\n');
  assert.match(text, /max \(1\) is lower than min \(3\)/);
  assert.match(text, /unknown associationType "missing"/);
  assert.match(text, /defined from 2-999, but the rule audits 2-123/);
  assert.match(text, /severity must be/);
  assert.match(text, /min 0 with no max can never fail/);
  assert.match(text, /exactly one of "in", "notIn" or "isEmpty"/);
});

test('out-of-range numeric settings are rejected and fall back to defaults', () => {
  const config = loadGuardConfig({ HUBSPOT_BATCH_SIZE: '500', ORPHAN_RATE_CIRCUIT_BREAKER: '2' });
  assert.equal(config.settings.batchSize, 100);
  assert.equal(config.settings.orphanRateCircuitBreaker, 0.5);
  assert.equal(config.problems.length, 2);
});

test('Slack URLs must be Slack incoming webhooks', () => {
  const { errors } = validateGuardConfig(loadGuardConfig({ SLACK_SANDBOX_WEBHOOK_URL: 'https://example.com/hook' }));
  assert.match(errors.join('\n'), /SLACK_SANDBOX_WEBHOOK_URL must start with https:\/\/hooks.slack.com\//);
});

test('production Slack is used only in live mode', () => {
  const base = { HUBSPOT_PRIVATE_APP_TOKEN: TOKEN, SLACK_WEBHOOK_URL: PROD_HOOK, SLACK_SANDBOX_WEBHOOK_URL: SANDBOX_HOOK };
  assert.equal(resolveSlackTarget(loadGuardConfig(base)).target, 'sandbox');
  assert.equal(resolveSlackTarget(loadGuardConfig({ ...base, DRY_RUN: 'false' })).target, 'sandbox');
  assert.equal(resolveSlackTarget(loadGuardConfig({ ...base, DRY_RUN: 'false', SANDBOX_MODE: 'false' })).target, 'production');
  assert.equal(resolveSlackTarget(loadGuardConfig({ HUBSPOT_PRIVATE_APP_TOKEN: TOKEN, DRY_RUN: 'false', SANDBOX_MODE: 'false' })).target, 'preview');
});

/* ---------- evaluation rules ---------- */

test('grace period, onlyWhen and skipWhen decide which records are evaluated', () => {
  const rule = { onlyWhen: [{ property: 'stage', notIn: ['archived'] }], skipWhen: [{ property: 'stage', in: ['cancelled'] }] };
  const settings = { gracePeriodHours: 24 };
  assert.equal(classifyRecord(RECORD, rule, NOW, settings), 'evaluate');
  assert.equal(classifyRecord({ ...RECORD, properties: { stage: 'archived' } }, rule, NOW, settings), 'excluded');
  assert.equal(classifyRecord({ ...RECORD, properties: { stage: 'cancelled' } }, rule, NOW, settings), 'excluded');
  assert.equal(classifyRecord({ ...RECORD, createdAt: new Date(NOW - 3600000).toISOString() }, rule, NOW, settings), 'grace');
  assert.equal(classifyRecord({ ...RECORD, createdAt: new Date(NOW - 3600000).toISOString() }, rule, NOW, { gracePeriodHours: 0 }), 'evaluate');
});

test('no associations at all is missing_association and orphans the record', () => {
  const violation = evaluateRequirement(RECORD, requirement(), [], null);
  assert.equal(violation.code, 'missing_association');
  assert.equal(statusFromViolations([violation]), 'orphaned');
  assert.equal(describeViolation(violation), 'Company: no association (needs at least 1)');
});

test('associations without the required label are label_mismatch', () => {
  const req = requirement({ associationTypeId: 101, associationCategory: 'USER_DEFINED', associationLabel: 'Primary Client' });
  const violation = evaluateRequirement(RECORD, req, [{ toObjectId: '9', types: [{ category: 'HUBSPOT_DEFINED', typeId: 101 }] }], null);
  assert.equal(violation.code, 'label_mismatch', 'the category must match as well as the typeId');
  assert.equal(evaluateRequirement(RECORD, req, [{ toObjectId: '9', types: [{ category: 'USER_DEFINED', typeId: 101 }] }], null), null);
});

test('more associations than max is a conflict', () => {
  const violation = evaluateRequirement(RECORD, requirement({ max: 1 }), [{ toObjectId: '1', types: [] }, { toObjectId: '2', types: [] }], null);
  assert.equal(violation.code, 'too_many_associations');
  assert.equal(statusFromViolations([violation]), 'conflict');
});

test('deleted parents and parents failing targetWhen do not count', () => {
  const index = { requested: { 1: true, 2: true }, found: { 2: { lifecyclestage: 'lead' } }, unknown: {} };
  const dangling = evaluateRequirement(RECORD, requirement({ verifyTargets: true }), [{ toObjectId: '1', types: [] }], index);
  assert.equal(dangling.code, 'dangling_association');
  const invalid = evaluateRequirement(RECORD, requirement({ verifyTargets: true, targetWhen: [{ property: 'lifecyclestage', in: ['customer'] }] }), [{ toObjectId: '2', types: [] }], index);
  assert.equal(invalid.code, 'invalid_parent');
});

test('parents that could not be read are treated as valid, never as orphans', () => {
  const index = { requested: { 1: true }, found: {}, unknown: { 1: true } };
  assert.equal(evaluateRequirement(RECORD, requirement({ verifyTargets: true }), [{ toObjectId: '1', types: [] }], index), null);
});

test('warning severity makes a record at_risk, and "when" scopes a requirement', () => {
  const warning = evaluateRequirement(RECORD, requirement({ severity: 'warning' }), [], null);
  assert.equal(statusFromViolations([warning]), 'at_risk');
  assert.equal(evaluateRequirement(RECORD, requirement({ when: [{ property: 'stage', in: ['closed'] }] }), [], null), null);
});

/* ---------- HubSpot parsing ---------- */

test('v4 "no associations" errors mean zero associations; other errors make the record unverifiable', () => {
  const plan = { ruleKey: 'r', fromObjectType: '2-1', toObjectType: 'companies', request: { body: { inputs: [{ id: '1' }, { id: '2' }, { id: '3' }] } } };
  const parsed = tagAssociationResponse(plan, {
    results: [{ from: { id: '1' }, to: [{ toObjectId: 7, associationTypes: [{ category: 'USER_DEFINED', typeId: '101', label: 'Primary' }] }], paging: { next: { after: 'x' } } }],
    errors: [
      { category: 'VALIDATION_ERROR', subCategory: 'crm.associations.NO_ASSOCIATIONS_FOUND', context: { fromObjectId: ['2'] } },
      { category: 'INTERNAL_ERROR', message: 'boom', context: { fromObjectId: ['3'] } },
    ],
  });
  assert.deepEqual(parsed.byFromId['1'], [{ toObjectId: '7', types: [{ category: 'USER_DEFINED', typeId: 101, label: 'Primary' }] }]);
  assert.equal(parsed.truncatedIds['1'], true);
  assert.deepEqual(parsed.errorIds, { 3: true });
  assert.throws(() => tagAssociationResponse(plan, { message: 'unexpected' }), /Unexpected HubSpot association response/);
});

test('batch read: not-found IDs are deleted parents, other errors are unknown', () => {
  const plan = { toObjectType: 'companies', request: { body: { inputs: [{ id: '1' }, { id: '2' }, { id: '3' }] } } };
  const parsed = tagTargetResponse(plan, {
    results: [{ id: '1', properties: { lifecyclestage: 'customer' } }],
    errors: [
      { category: 'OBJECT_NOT_FOUND', message: 'Could not get some COMPANY objects', context: { ids: ['2'] } },
      { category: 'RATE_LIMITS', message: 'try later', context: { ids: ['3'] } },
    ],
  });
  assert.deepEqual(Object.keys(parsed.found), ['1']);
  assert.deepEqual(parsed.unknown, { 3: true });
});

test('a stage with missing responses stops the run', () => {
  assert.throws(() => assertStageComplete('association read', 3, 2), /planned 3 request\(s\) but received 2/);
  assert.doesNotThrow(() => assertStageComplete('association read', 0, 0));
});

test('list requests ask for every property the rules use', () => {
  const [plan] = planRecordFetch(loadGuardConfig(hubspotEnv()));
  const properties = decodeURIComponent(new URL(plan.request.url).searchParams.get('properties')).split(',');
  for (const name of ['association_integrity_status', 'association_integrity_issues', 'hs_createdate', 'project_name', 'project_status']) assert.ok(properties.includes(name), name);
  assert.equal(plan.maxPages, 100);
  assert.ok(!plan.request.url.includes(TOKEN));
});

test('sandbox enforcement accepts sandbox, developer test and the pinned portal only', () => {
  const config = loadGuardConfig(hubspotEnv({ HUBSPOT_SANDBOX_PORTAL_ID: '555' }));
  assert.equal(enforceSandbox({ portalId: 1, accountType: 'SANDBOX' }, config).ok, true);
  assert.equal(enforceSandbox({ portalId: 1, accountType: 'DEVELOPER_TEST' }, config).ok, true);
  assert.equal(enforceSandbox({ portalId: 555, accountType: 'STANDARD' }, config).ok, true);
  assert.equal(enforceSandbox({ portalId: 1, accountType: 'STANDARD' }, config).ok, false);
  assert.equal(enforceSandbox({ portalId: 1, accountType: 'STANDARD' }, loadGuardConfig(hubspotEnv({ SANDBOX_MODE: 'false' }))).ok, true);
});

test('record links use the portal data-hosting domain and standard object IDs', () => {
  const account = summarizeAccount({ dataHostingLocation: 'eu1' }, { portalId: '123', accountType: 'SANDBOX', reason: '' });
  assert.equal(recordUrl(account, '2-1000001', '9'), 'https://app-eu1.hubspot.com/contacts/123/record/2-1000001/9');
  assert.equal(recordUrl(account, 'deals', '9'), 'https://app-eu1.hubspot.com/contacts/123/record/0-3/9');
  assert.equal(recordUrl({ portalId: 'DEMO' }, '2-1', '9'), null);
  assert.equal(summarizeAccount({ uiDomain: 'app-na2.hubspot.com', dataHostingLocation: 'na2' }, { portalId: '1' }).uiDomain, 'app-na2.hubspot.com');
  assert.equal(summarizeAccount({ uiDomain: 'evil.example.com' }, { portalId: '1' }).uiDomain, 'app.hubspot.com');
});

/* ---------- the bundled demo run ---------- */

test('demo audit classifies every sample record as designed', async () => {
  const { report } = await runDemoAudit({});
  const status = Object.fromEntries(report.findings.map((finding) => [finding.id, `${finding.status}:${finding.violations.map((v) => v.code).join('+')}`]));
  assert.deepEqual(status, {
    1002: 'orphaned:missing_association+missing_association',
    1003: 'orphaned:label_mismatch',
    1005: 'orphaned:invalid_parent',
    1009: 'orphaned:dangling_association',
    2003: 'orphaned:missing_association',
    2004: 'orphaned:missing_association',
    5002: 'orphaned:invalid_parent',
    5003: 'orphaned:missing_association',
    1004: 'conflict:too_many_associations',
    2002: 'at_risk:missing_association',
    5006: 'unverified:',
  });
  assert.deepEqual(report.cleared.map((entry) => entry.id), ['1008']);
  assert.deepEqual(
    { scanned: report.totals.scanned, evaluated: report.totals.evaluated, grace: report.totals.skippedGrace, excluded: report.totals.skippedExcluded, healthy: report.totals.healthy },
    { scanned: 20, evaluated: 16, grace: 1, excluded: 3, healthy: 5 },
  );
});

test('dry run plans flag updates but writes nothing', async () => {
  const { flagPlan, flagResults, mock } = await runDemoAudit({});
  assert.equal(flagPlan.writesAllowed, false);
  assert.equal(flagPlan.plannedCount, 10);
  assert.equal(flagPlan.skipped.unchanged, 1, 'shipment 2004 already carries the same flag');
  assert.equal(flagPlan.skipped.unverified, 1);
  assert.equal(flagResults.executed, false);
  assert.equal(mock.calls.filter((call) => call.path.endsWith('/batch/update')).length, 0);
});

test('DRY_RUN=false alone still writes nothing until FLAG_WRITES_ENABLED=true', async () => {
  const { flagPlan } = await runDemoAudit({ DRY_RUN: 'false' });
  assert.equal(flagPlan.writesAllowed, false);
  assert.match(flagPlan.reason, /FLAG_WRITES_ENABLED/);
});

test('enabled writes update the flags, clear fixed records and are idempotent', async () => {
  const state = createDemoState();
  state.account.portalId = 12345;
  const mock = createMockHubSpot(state);
  const config = loadGuardConfig(hubspotEnv({ DRY_RUN: 'false', FLAG_WRITES_ENABLED: 'true' }));
  const first = await runAudit({ config, http: mock.request, now: NOW });
  assert.equal(first.flagResults.updated, 10);
  assert.equal(state.objects['2-1000001'][1002].properties.association_integrity_status, 'orphaned');
  assert.equal(state.objects['2-1000001'][1004].properties.association_integrity_status, 'conflict');
  assert.equal(state.objects['2-1000001'][1008].properties.association_integrity_status, 'healthy');
  assert.equal(state.objects['2-1000001'][1008].properties.association_integrity_issues, '');
  assert.equal(state.objects['2-1000001'][1001].properties.association_integrity_status, undefined, 'never-flagged healthy records are left alone');
  assert.equal(state.objects['2-1000003'][5006].properties.association_integrity_status, undefined, 'unverified records are never flagged');
  assert.equal(state.objects['2-1000001'][1002].properties.association_integrity_checked_at, DEMO_NOW);

  const second = await runAudit({ config, http: mock.request, now: NOW + 86400000 });
  assert.equal(second.flagPlan.skipped.unchanged, 10, 'unchanged flags are not rewritten');
  assert.deepEqual(second.flagPlan.updates.map((update) => update.id), ['1006'], 'only the project that left its grace period is new');
});

test('MAX_FLAG_UPDATES_PER_RUN caps writes, keeping the most severe first', async () => {
  const { flagPlan } = await runDemoAudit({ MAX_FLAG_UPDATES_PER_RUN: '3' });
  assert.equal(flagPlan.plannedCount, 3);
  assert.equal(flagPlan.skipped.deferredByCap, 7);
  assert.ok(flagPlan.updates.every((update) => update.status === 'orphaned'));
});

test('the circuit breaker suppresses writes for an object with an implausible orphan rate', async () => {
  const { report, flagPlan } = await runDemoAudit({ CIRCUIT_BREAKER_MIN_SAMPLE: '3', ORPHAN_RATE_CIRCUIT_BREAKER: '0.5' });
  const projects = report.rules.find((rule) => rule.key === 'projects');
  assert.equal(projects.circuitBreaker.tripped, true);
  assert.ok(flagPlan.updates.every((update) => update.ruleKey !== 'projects'));
  assert.ok(flagPlan.skipped.circuitBreaker >= 4);
});

test('pagination and MAX_RECORDS_PER_OBJECT mark partial audits', async () => {
  const state = createDemoState();
  state.maxPageSize = 2;
  const config = loadDemoConfig({ MAX_RECORDS_PER_OBJECT: '4', HUBSPOT_PAGE_SIZE: '2' });
  const { report } = await runAudit({ config, http: createMockHubSpot(state).request, now: NOW });
  const projects = report.rules.find((rule) => rule.key === 'projects');
  assert.equal(projects.scanned, 4);
  assert.equal(projects.truncated, true);
  const shipments = report.rules.find((rule) => rule.key === 'shipments');
  assert.equal(shipments.scanned, 4);
});

test('assembleDataset merges chunked association responses', () => {
  const config = loadDemoConfig({});
  const dataset = assembleDataset({
    config,
    pages: [],
    associationResponses: [
      { ruleKey: 'projects', toObjectType: 'companies', requested: ['1'], byFromId: { 1: [{ toObjectId: '9', types: [] }] }, truncatedIds: {}, errorIds: {} },
      { ruleKey: 'projects', toObjectType: 'companies', requested: ['2'], byFromId: {}, truncatedIds: {}, errorIds: { 2: true } },
    ],
  });
  assert.deepEqual(Object.keys(dataset.associations.projects.companies.requested), ['1', '2']);
  assert.equal(dataset.associations.projects.companies.errorIds['2'], true);
});

test('flag update requests are chunked per object type', () => {
  const config = loadGuardConfig({ HUBSPOT_BATCH_SIZE: '2' });
  const updates = ['1', '2', '3'].map((id) => ({ objectTypeId: '2-1', id, properties: { a: 'b' } })).concat([{ objectTypeId: '2-2', id: '9', properties: {} }]);
  const requests = buildFlagUpdateRequests(updates, config);
  assert.deepEqual(requests.map((request) => request.request.body.inputs.length), [2, 1, 1]);
  assert.match(requests[0].request.url, /\/crm\/v3\/objects\/2-1\/batch\/update$/);
});

/* ---------- Slack ---------- */

test('Slack alerts carry counts and links but no record names by default', async () => {
  const state = createDemoState();
  state.account.portalId = 12345;
  const config = loadGuardConfig(hubspotEnv());
  const result = await runAudit({ config, http: createMockHubSpot(state).request, now: NOW });
  const message = buildSlackAlert({ ...result, config });
  const text = JSON.stringify(message);
  assert.match(message.text, /\[DRY RUN \| SANDBOX\] Association Integrity Guard: 8 orphaned, 1 conflicting, 1 at risk/);
  assert.match(text, /https:\/\/app\.hubspot\.com\/contacts\/12345\/record\/2-1000001\/1002/);
  assert.ok(!text.includes('Unlinked migration project'), 'record names stay out of Slack by default');
  assert.ok(message.blocks.length <= 50);
  for (const block of message.blocks) if (block.text) assert.ok(block.text.text.length <= 3000);

  const named = JSON.stringify(buildSlackAlert({ ...result, config: loadGuardConfig(hubspotEnv({ SLACK_INCLUDE_RECORD_NAMES: 'true' })) }));
  assert.ok(named.includes('Unlinked migration project'));
});

test('clean runs stay quiet unless ALERT_ON_CLEAN_RUN=true', () => {
  const report = { totals: { orphaned: 0, conflict: 0, atRisk: 0, unverified: 0 }, rules: [{ truncated: false, circuitBreaker: { tripped: false } }] };
  assert.equal(shouldAlert(report, loadGuardConfig({})), false);
  assert.equal(shouldAlert(report, loadGuardConfig({ ALERT_ON_CLEAN_RUN: 'true' })), true);
});

test('failure alerts redact tokens and webhook URLs', () => {
  const message = buildFailureAlert({ errorMessage: `Request failed: Authorization: Bearer ${TOKEN} posting to ${PROD_HOOK}?token=abc`, lastNode: 'HubSpot: Batch Read Associations (v4)', executionId: '42', mode: 'hubspot' });
  const text = JSON.stringify(message);
  assert.ok(!text.includes(TOKEN));
  assert.ok(!text.includes('PRODUCTION'));
  assert.equal(redactSecrets('x?api_key=secret&y=1'), 'x?api_key=[redacted]&y=1');
});

/* ---------- full runs ---------- */

test('runGuard posts to the sandbox webhook only, and refuses production portals in sandbox mode', async () => {
  const posted = [];
  const fetchImpl = async (url) => { posted.push(url); return { ok: true, status: 200 }; };
  const state = createDemoState();
  const config = loadGuardConfig(hubspotEnv({ SLACK_WEBHOOK_URL: PROD_HOOK, SLACK_SANDBOX_WEBHOOK_URL: SANDBOX_HOOK }));
  const result = await runGuard({ config, fetchImpl, http: createMockHubSpot(state).request });
  assert.equal(result.slack.status, 'sent to the sandbox webhook');
  assert.deepEqual(posted, [SANDBOX_HOOK]);

  state.account.accountType = 'STANDARD';
  await assert.rejects(runGuard({ config, fetchImpl, http: createMockHubSpot(state).request }), /SANDBOX_MODE=true, but the connected portal/);
});

test('the HubSpot HTTP client retries 429 responses and never leaks the token in errors', async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    assert.equal(init.headers.Authorization, `Bearer ${TOKEN}`);
    if (calls === 1) return { ok: false, status: 429, headers: { get: () => '0.01' }, text: async () => '{"message":"slow down"}' };
    if (calls === 2) return { ok: true, status: 200, headers: { get: () => null }, text: async () => '{"results":[]}' };
    return { ok: false, status: 401, headers: { get: () => null }, text: async () => `{"message":"bad token Bearer ${TOKEN}"}` };
  };
  const http = createHubSpotHttp({ token: TOKEN, fetchImpl, baseDelayMs: 1 });
  assert.deepEqual((await http({ method: 'GET', url: 'https://api.hubapi.com/crm/v3/schemas' })).body, { results: [] });
  await assert.rejects(http({ method: 'GET', url: 'https://api.hubapi.com/crm/v3/schemas' }), (error) => error.status === 401 && !error.message.includes(TOKEN));
});

test('.env parsing handles quotes, comments and export prefixes', () => {
  assert.deepEqual(parseDotEnv('# c\nA=1\nexport B="two words"\nC=three # note\nD=\'{"x":1}\'\n'), { A: '1', B: 'two words', C: 'three', D: '{"x":1}' });
});

test('an audit with zero rules matched still produces a valid empty report', () => {
  const config = loadGuardConfig({});
  const report = auditDataset({ config, dataset: { records: {}, associations: {}, targets: {} }, now: NOW });
  assert.equal(report.totals.rules, 0);
  assert.equal(planFlagUpdates(report, config).plannedCount, 0);
});
