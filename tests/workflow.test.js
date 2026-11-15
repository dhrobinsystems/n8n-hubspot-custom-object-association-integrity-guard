import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildWorkflow, NODE, serializeWorkflow, WORKFLOW_PATH } from '../scripts/build-workflow.js';
import { runWorkflow } from './n8n-simulator.js';
import { createMockHubSpot } from '../src/core/mockHubSpot.js';
import { createDemoState, DEMO_GUARD_DOCUMENT, DEMO_NOW } from '../src/core/demoData.js';
import { loadGuardConfig } from '../src/core/config.js';
import { runAudit, runDemoAudit } from '../src/core/pipeline.js';
import { buildSlackAlert } from '../src/core/slack.js';

const workflow = JSON.parse(readFileSync(WORKFLOW_PATH, 'utf8'));
const TOKEN = 'test-token-not-a-real-credential';
const SANDBOX_HOOK = 'https://hooks.slack.com/services/EXAMPLE/SANDBOX/EXAMPLE';

function env(extra = {}) {
  return { HUBSPOT_PRIVATE_APP_TOKEN: TOKEN, GUARD_CONFIG_JSON: JSON.stringify(DEMO_GUARD_DOCUMENT), AUDIT_NOW: DEMO_NOW, SLACK_SANDBOX_WEBHOOK_URL: SANDBOX_HOOK, ...extra };
}

function portal({ pageSize = 3, accountType = 'SANDBOX' } = {}) {
  const state = createDemoState();
  state.account.portalId = 12345678;
  state.account.accountType = accountType;
  state.maxPageSize = pageSize;
  return state;
}

function router(mock, slack) {
  return async (request) => {
    if (request.url.startsWith('https://hooks.slack.com/')) {
      slack.push(request);
      return { status: 200, body: 'ok' };
    }
    assert.equal(request.headers.Authorization, `Bearer ${TOKEN}`, `${request.url} must carry the token from $env`);
    return mock.request(request);
  };
}

test('workflow.json is exactly what the build script produces', () => {
  assert.equal(readFileSync(WORKFLOW_PATH, 'utf8'), serializeWorkflow());
});

test('workflow structure: inactive, privacy-preserving settings, valid connections', () => {
  assert.equal(workflow.active, false);
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
  assert.equal(workflow.settings.executionOrder, 'v1');
  const names = new Set(workflow.nodes.map((node) => node.name));
  assert.equal(names.size, workflow.nodes.length, 'node names are unique');
  assert.equal(new Set(workflow.nodes.map((node) => node.id)).size, workflow.nodes.length, 'node IDs are unique');
  for (const [source, { main }] of Object.entries(workflow.connections)) {
    assert.ok(names.has(source), source);
    for (const branch of main) for (const connection of branch) assert.ok(names.has(connection.node), connection.node);
  }
  const types = workflow.nodes.map((node) => node.type);
  for (const type of ['n8n-nodes-base.scheduleTrigger', 'n8n-nodes-base.httpRequest', 'n8n-nodes-base.code', 'n8n-nodes-base.errorTrigger']) assert.ok(types.includes(type), type);
  const schedule = workflow.nodes.find((node) => node.name === NODE.schedule);
  assert.equal(schedule.parameters.rule.interval[0].expression, '0 6 * * 1-5');
});

test('no credentials are embedded; HubSpot auth and Slack URLs come from $env at request time', () => {
  const text = JSON.stringify(workflow);
  assert.ok(!/pat-(?:na|eu)\d-[0-9a-f-]{20,}/i.test(text), 'no HubSpot private app tokens');
  assert.ok(!/hooks\.slack\.com\/services\/T[A-Z0-9]{6,}/.test(text), 'no Slack webhook paths');
  for (const node of workflow.nodes.filter((entry) => entry.type === 'n8n-nodes-base.httpRequest')) {
    const header = node.parameters.headerParameters && node.parameters.headerParameters.parameters[0];
    if (node.name.startsWith('HubSpot')) {
      assert.equal(header.value, '=Bearer {{ $env.HUBSPOT_PRIVATE_APP_TOKEN }}');
      assert.equal(node.retryOnFail, true);
      assert.equal(node.onError, undefined, `${node.name} must fail the run instead of continuing on partial data`);
    } else {
      assert.match(node.parameters.url, /\$env\.SLACK_WEBHOOK_URL : \$env\.SLACK_SANDBOX_WEBHOOK_URL/);
    }
  }
});

test('demo mode in n8n matches the Node.js demo run and makes no HTTP calls', async () => {
  const run = await runWorkflow(workflow, { env: {}, http: async () => { throw new Error('demo mode must not call HTTP'); } });
  assert.ok(run.executed.includes(NODE.demo));
  assert.ok(!run.executed.includes(NODE.account));
  assert.ok(!run.executed.includes(NODE.sendAlert), 'no sandbox webhook configured, so nothing is sent');
  const mirror = await runDemoAudit({});
  assert.deepEqual(run.output(NODE.demo)[0].report, mirror.report);
  const summary = run.output(NODE.summary)[0];
  assert.equal(summary.totals.orphaned, 8);
  assert.match(summary.slack.status, /^not sent/);
  assert.match(summary.preview, /DEMO DATA \| DRY RUN \| SANDBOX/);
});

test('hubspot mode in n8n (paginated, dry run) matches the Node.js mirror exactly', async () => {
  const slack = [];
  const mock = createMockHubSpot(portal());
  const run = await runWorkflow(workflow, { env: env(), http: router(mock, slack) });
  const mirror = await runAudit({ config: loadGuardConfig(env()), http: createMockHubSpot(portal()).request, now: Date.parse(DEMO_NOW) });

  const evaluated = run.output(NODE.evaluate)[0];
  assert.deepEqual(evaluated.report, mirror.report);
  assert.deepEqual(evaluated.flagPlan, mirror.flagPlan);
  assert.ok(run.output(NODE.listRecords).length > 3, 'pagination fetched several pages');
  assert.ok(!run.executed.includes(NODE.writeFlags), 'dry run never reaches the write node');
  assert.equal(mock.calls.filter((call) => call.path.endsWith('/batch/update')).length, 0);

  assert.equal(slack.length, 1);
  assert.equal(slack[0].url, SANDBOX_HOOK);
  assert.deepEqual(slack[0].body, buildSlackAlert({ report: mirror.report, flagPlan: mirror.flagPlan, flagResults: mirror.flagResults, config: loadGuardConfig(env()) }));
  assert.equal(run.output(NODE.summary)[0].slack.status, 'sent to the sandbox webhook');
});

test('n8n flag writes match the mirror and leave HubSpot in the same state', async () => {
  const writeEnv = env({ DRY_RUN: 'false', FLAG_WRITES_ENABLED: 'true' });
  const n8nPortal = portal();
  const mirrorPortal = portal();
  const run = await runWorkflow(workflow, { env: writeEnv, http: router(createMockHubSpot(n8nPortal), []) });
  const mirror = await runAudit({ config: loadGuardConfig(writeEnv), http: createMockHubSpot(mirrorPortal).request, now: Date.parse(DEMO_NOW) });
  assert.ok(run.executed.includes(NODE.writeFlags));
  assert.deepEqual(run.output(NODE.summary)[0].flagResults, mirror.flagResults);
  assert.equal(mirror.flagResults.updated, 10);
  assert.deepEqual(n8nPortal.objects, mirrorPortal.objects);
});

test('n8n stops before reading records when the portal is not a sandbox', async () => {
  const mock = createMockHubSpot(portal({ accountType: 'STANDARD' }));
  await assert.rejects(runWorkflow(workflow, { env: env(), http: router(mock, []) }), /SANDBOX_MODE=true, but the connected portal/);
  assert.deepEqual(mock.calls.map((call) => call.path), ['/account-info/v3/details']);
});

test('n8n refuses to start on invalid configuration', async () => {
  await assert.rejects(runWorkflow(workflow, { env: { DRY_RUN: 'false', SANDBOX_MODE: 'false' }, http: async () => ({ status: 200, body: {} }) }), /Configuration invalid/);
  await assert.rejects(runWorkflow(workflow, { env: { HUBSPOT_PRIVATE_APP_TOKEN: TOKEN }, http: async () => ({ status: 200, body: {} }) }), /GUARD_CONFIG_JSON is missing/);
});

test('a failed association read stops the n8n run with no flag writes', async () => {
  const mock = createMockHubSpot(portal());
  const writeEnv = env({ DRY_RUN: 'false', FLAG_WRITES_ENABLED: 'true' });
  const http = async (request) => (request.url.includes('/crm/v4/associations/') ? { status: 500, body: { message: 'upstream error' } } : router(mock, [])(request));
  await assert.rejects(runWorkflow(workflow, { env: writeEnv, http }), /Batch Read Associations \(v4\)" received 500/);
  assert.equal(mock.calls.filter((call) => call.path.endsWith('/batch/update')).length, 0);
});

test('objects with no evaluable records skip the association and parent stages cleanly', async () => {
  const state = portal();
  for (const type of ['2-1000001', '2-1000002', '2-1000003']) state.objects[type] = {};
  const run = await runWorkflow(workflow, { env: env(), http: router(createMockHubSpot(state), []) });
  assert.ok(!run.executed.includes(NODE.readAssociations));
  assert.ok(!run.executed.includes(NODE.readTargets));
  const summary = run.output(NODE.summary)[0];
  assert.equal(summary.totals.scanned, 0);
  assert.match(summary.slack.status, /nothing to report/);
});

test('the error branch builds a redacted failure alert for the sandbox webhook', async () => {
  const slack = [];
  const failure = { execution: { id: '77', lastNodeExecuted: NODE.readAssociations, error: { message: `401 for Bearer ${TOKEN}` } }, workflow: { name: workflow.name } };
  const run = await runWorkflow(workflow, { env: env(), startNode: NODE.errorTrigger, triggerItems: [{ json: failure }], http: async (request) => { slack.push(request); return { status: 200, body: 'ok' }; } });
  assert.ok(run.executed.includes(NODE.sendFailure));
  assert.equal(slack[0].url, SANDBOX_HOOK);
  assert.ok(!JSON.stringify(slack[0].body).includes(TOKEN));
  assert.match(slack[0].body.text, /failed in "HubSpot: Batch Read Associations \(v4\)"/);
});

test('every node in the graph is reachable from a trigger (except the sticky note)', () => {
  const built = buildWorkflow();
  const reachable = new Set();
  const visit = (name) => {
    if (reachable.has(name)) return;
    reachable.add(name);
    for (const branch of (built.connections[name] && built.connections[name].main) || []) for (const connection of branch) visit(connection.node);
  };
  for (const trigger of [NODE.schedule, NODE.manual, NODE.errorTrigger]) visit(trigger);
  const unreachable = built.nodes.map((node) => node.name).filter((name) => !reachable.has(name));
  assert.deepEqual(unreachable, [NODE.note]);
});
