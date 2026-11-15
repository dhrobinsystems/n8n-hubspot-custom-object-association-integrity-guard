/**
 * The Node.js mirror of workflow.json. It runs the same planning and parsing functions in the same
 * order as the n8n nodes, so a local run and an n8n run produce the same report for the same data.
 */
import { resolveSlackTarget, validateGuardConfig, resolveNow } from './config.js';
import { auditDataset, planFlagUpdates } from './integrity.js';
import {
  assembleDataset,
  assembleRecords,
  buildAccountDetailsRequest,
  buildFlagUpdateRequests,
  enforceSandbox,
  planAssociationReads,
  planRecordFetch,
  planTargetVerification,
  summarizeAccount,
  summarizeFlagWrites,
  tagAssociationResponse,
  tagFlagWriteResponse,
  tagRecordPage,
  tagTargetResponse,
} from './hubspot.js';
import { buildSlackAlert, redactSecrets, shouldAlert, summarizeReport } from './slack.js';
import { createDemoState, DEMO_NOW, loadDemoConfig } from './demoData.js';
import { createMockHubSpot } from './mockHubSpot.js';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * Wraps fetch for HubSpot: bearer auth, JSON bodies, retries on 429 and 5xx (honouring Retry-After).
 * Any other non-2xx response throws, which stops the run before flags are written.
 */
export function createHubSpotHttp({ token, fetchImpl = globalThis.fetch, maxRetries = 3, baseDelayMs = 1000, log = () => {} }) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available. Use Node.js 20 or newer.');
  return async function hubspotRequest(req) {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetchImpl(req.url, {
        method: req.method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
      });
      const text = await response.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text }; }
      if (response.ok) return { status: response.status, body };
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < maxRetries) {
        const retryAfter = Number(response.headers && response.headers.get ? response.headers.get('retry-after') : NaN);
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** attempt;
        log(`HubSpot returned ${response.status}; retrying in ${wait} ms`);
        await sleep(wait);
        continue;
      }
      const message = body && body.message ? body.message : text.slice(0, 300);
      const error = new Error(redactSecrets(`HubSpot ${req.method} ${new URL(req.url).pathname} failed with ${response.status}: ${message}`));
      error.status = response.status;
      throw error;
    }
  };
}

function ensureOk(response, req) {
  if (!response || response.status < 200 || response.status >= 300) {
    const message = response && response.body && response.body.message ? response.body.message : 'no details';
    const error = new Error(`HubSpot ${req.method} ${new URL(req.url).pathname} failed with ${response ? response.status : 'no response'}: ${message}`);
    error.status = response ? response.status : null;
    throw error;
  }
  return response.body;
}

/** Runs one audit. `http(req)` must resolve to { status, body }. */
export async function runAudit({ config, http, now, log = () => {} }) {
  const accountRequest = buildAccountDetailsRequest(config);
  const account = ensureOk(await http(accountRequest), accountRequest);
  const gate = enforceSandbox(account, config);
  if (!gate.ok) throw new Error(gate.reason);
  const accountSummary = summarizeAccount(account, gate);

  const pages = [];
  for (const plan of planRecordFetch(config)) {
    let after = null;
    let fetched = 0;
    do {
      const url = after ? `${plan.request.url}&after=${encodeURIComponent(after)}` : plan.request.url;
      const req = { method: 'GET', url };
      const page = tagRecordPage(plan, ensureOk(await http(req), req));
      pages.push(page);
      fetched += 1;
      after = page.nextAfter;
    } while (after && fetched < plan.maxPages);
    log(`Fetched ${fetched} page(s) of ${plan.objectTypeId}`);
  }

  const records = assembleRecords(pages, config);
  const associationResponses = [];
  for (const plan of planAssociationReads(config, records, now)) {
    associationResponses.push(tagAssociationResponse(plan, ensureOk(await http(plan.request), plan.request)));
  }
  const targetResponses = [];
  for (const plan of planTargetVerification(config, records, associationResponses)) {
    targetResponses.push(tagTargetResponse(plan, ensureOk(await http(plan.request), plan.request)));
  }

  const dataset = assembleDataset({ config, pages, associationResponses, targetResponses });
  const report = auditDataset({ config, dataset, now, account: accountSummary });
  const flagPlan = planFlagUpdates(report, config);

  let flagResults = { executed: false, batches: 0, attempted: 0, updated: 0, failed: 0 };
  if (flagPlan.writesAllowed && flagPlan.updates.length) {
    const tags = [];
    for (const plan of buildFlagUpdateRequests(flagPlan.updates, config)) {
      tags.push(tagFlagWriteResponse(plan, ensureOk(await http(plan.request), plan.request)));
    }
    flagResults = summarizeFlagWrites(tags);
  }
  return { account: accountSummary, report, flagPlan, flagResults };
}

/** Demo mode: the bundled dataset behind the in-memory HubSpot mock, at a fixed clock. */
export async function runDemoAudit(env = {}) {
  const config = loadDemoConfig(env);
  const mock = createMockHubSpot(createDemoState());
  const result = await runAudit({ config, http: mock.request, now: Date.parse(DEMO_NOW) });
  return { ...result, config, mock };
}

export async function postSlack(url, payload, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`Slack webhook returned ${response.status}`);
  return response.status;
}

/** Full run: validate, audit, build the alert and deliver it to the permitted target. */
export async function runGuard({ config, fetchImpl = globalThis.fetch, log = () => {}, http } = {}) {
  const { errors, warnings } = validateGuardConfig(config);
  if (errors.length) {
    const error = new Error(`Configuration invalid:\n- ${errors.join('\n- ')}`);
    error.validationErrors = errors;
    throw error;
  }
  for (const warning of warnings) log(`warning: ${warning}`);

  let result;
  if (config.mode === 'demo') {
    const mock = createMockHubSpot(createDemoState());
    result = await runAudit({ config, http: http || mock.request, now: Date.parse(DEMO_NOW), log });
  } else {
    result = await runAudit({ config, http: http || createHubSpotHttp({ token: config.hubspot.token, fetchImpl, log }), now: resolveNow(config), log });
  }

  const slack = resolveSlackTarget(config);
  const alertNeeded = shouldAlert(result.report, config);
  const message = buildSlackAlert({ report: result.report, flagPlan: result.flagPlan, flagResults: result.flagResults, config });
  let slackStatus = alertNeeded ? `not sent: ${slack.reason}` : 'not sent: nothing to report (set ALERT_ON_CLEAN_RUN=true to always alert)';
  if (alertNeeded && slack.target !== 'preview') {
    const url = slack.target === 'production' ? config.slack.webhookUrl : config.slack.sandboxWebhookUrl;
    await postSlack(url, message, fetchImpl);
    slackStatus = `sent to the ${slack.target} webhook`;
  }
  return { ...result, summary: summarizeReport(result.report), slack: { ...slack, alertNeeded, status: slackStatus, message } };
}
