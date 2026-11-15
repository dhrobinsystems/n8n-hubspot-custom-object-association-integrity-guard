/**
 * HubSpot request builders and response parsers.
 *
 * The same functions run in two places: inside the n8n Code nodes (which plan requests that the
 * HTTP Request nodes execute) and inside the Node.js mirror in src/core/pipeline.js. Nothing in
 * this file performs network calls, and no request object carries the access token.
 */
import { enabledRules, isPlaceholder, SANDBOX_ACCOUNT_TYPES } from './config.js';
import { classifyRecord, compareIds, matchesAssociationType, requiredObjectTypes } from './integrity.js';

export const STANDARD_OBJECT_TYPE_IDS = Object.freeze({ contacts: '0-1', companies: '0-2', deals: '0-3', tickets: '0-5' });

export function hubspotUrl(config, path) {
  return `${config.hubspot.baseUrl.replace(/\/+$/, '')}${path}`;
}

function chunk(list, size) {
  const chunks = [];
  for (let index = 0; index < list.length; index += size) chunks.push(list.slice(index, index + size));
  return chunks;
}

export function buildAccountDetailsRequest(config) {
  return { method: 'GET', url: hubspotUrl(config, '/account-info/v3/details') };
}

/** Refuses to continue when SANDBOX_MODE=true and the token belongs to a non-sandbox portal. */
export function enforceSandbox(account, config) {
  const portalId = account && account.portalId !== undefined && account.portalId !== null ? String(account.portalId) : null;
  const accountType = account && account.accountType ? String(account.accountType).toUpperCase() : null;
  if (!config.sandboxMode) return { ok: true, portalId, accountType, reason: 'SANDBOX_MODE=false, so production portals are allowed' };
  if (accountType && SANDBOX_ACCOUNT_TYPES.includes(accountType)) {
    return { ok: true, portalId, accountType, reason: `portal account type ${accountType} is a sandbox or test account` };
  }
  if (portalId && !isPlaceholder(config.hubspot.sandboxPortalId) && portalId === config.hubspot.sandboxPortalId) {
    return { ok: true, portalId, accountType, reason: 'portal ID matches HUBSPOT_SANDBOX_PORTAL_ID' };
  }
  return {
    ok: false,
    portalId,
    accountType,
    reason: `SANDBOX_MODE=true, but the connected portal (account type ${accountType || 'unknown'}) is not a sandbox or developer test account and does not match HUBSPOT_SANDBOX_PORTAL_ID. I refuse to continue.`,
  };
}

export function summarizeAccount(account, gate) {
  const reported = account && typeof account.uiDomain === 'string' ? account.uiDomain.trim().toLowerCase() : '';
  const location = account && account.dataHostingLocation ? String(account.dataHostingLocation).toLowerCase() : null;
  let uiDomain = 'app.hubspot.com';
  if (/^app(?:-[a-z0-9]+)?\.hubspot\.com$/.test(reported)) uiDomain = reported;
  else if (location && location !== 'na1' && /^[a-z]{2}\d$/.test(location)) uiDomain = `app-${location}.hubspot.com`;
  return { portalId: gate.portalId, accountType: gate.accountType, uiDomain, sandboxCheck: gate.reason };
}

export function recordUrl(account, objectTypeId, id) {
  if (!account || !/^\d+$/.test(String(account.portalId || ''))) return null;
  const typeId = STANDARD_OBJECT_TYPE_IDS[objectTypeId] || objectTypeId;
  return `https://${account.uiDomain || 'app.hubspot.com'}/contacts/${account.portalId}/record/${typeId}/${id}`;
}

export function recordPropertiesForRule(rule) {
  const names = new Set(['hs_createdate']);
  if (rule.displayProperty) names.add(rule.displayProperty);
  if (rule.flag) for (const name of [rule.flag.status, rule.flag.issues]) if (name) names.add(name);
  for (const condition of [...rule.onlyWhen, ...rule.skipWhen]) names.add(condition.property);
  for (const requirement of rule.requirements) for (const condition of requirement.when) names.add(condition.property);
  for (const name of rule.properties) names.add(name);
  return [...names].sort();
}

/** One paginated list request per enabled rule. */
export function planRecordFetch(config) {
  const { pageSize, maxRecordsPerObject } = config.settings;
  return enabledRules(config).map((rule) => ({
    stage: 'records',
    ruleKey: rule.key,
    objectTypeId: rule.objectTypeId,
    maxPages: Math.max(1, Math.ceil(maxRecordsPerObject / pageSize)),
    request: {
      method: 'GET',
      url: hubspotUrl(config, `/crm/v3/objects/${encodeURIComponent(rule.objectTypeId)}?limit=${pageSize}&archived=false&properties=${encodeURIComponent(recordPropertiesForRule(rule).join(','))}`),
    },
  }));
}

export function tagRecordPage(plan, body) {
  if (!body || !Array.isArray(body.results)) throw new Error(`Unexpected HubSpot list response for ${plan.objectTypeId}: "results" is missing`);
  const next = body.paging && body.paging.next && body.paging.next.after;
  return {
    stage: 'records',
    ruleKey: plan.ruleKey,
    objectTypeId: plan.objectTypeId,
    records: body.results.map((record) => ({
      id: String(record.id),
      createdAt: record.createdAt || null,
      properties: record.properties || {},
    })),
    nextAfter: next ? String(next) : null,
  };
}

/** Groups list pages by rule, removes duplicates, applies MAX_RECORDS_PER_OBJECT and sorts by ID. */
export function assembleRecords(pages, config) {
  const buckets = {};
  for (const rule of enabledRules(config)) buckets[rule.key] = { records: [], truncated: false, pages: 0, pagesWithNext: 0, seen: {} };
  for (const page of pages) {
    const bucket = buckets[page.ruleKey];
    if (!bucket) continue;
    bucket.pages += 1;
    if (page.nextAfter) bucket.pagesWithNext += 1;
    for (const record of page.records) {
      if (bucket.seen[record.id]) continue;
      bucket.seen[record.id] = true;
      bucket.records.push(record);
    }
  }
  const result = {};
  for (const [key, bucket] of Object.entries(buckets)) {
    bucket.records.sort((a, b) => compareIds(a.id, b.id));
    let truncated = bucket.pages > 0 && bucket.pagesWithNext === bucket.pages;
    let records = bucket.records;
    if (records.length > config.settings.maxRecordsPerObject) {
      records = records.slice(0, config.settings.maxRecordsPerObject);
      truncated = true;
    }
    result[key] = { records, truncated, pages: bucket.pages };
  }
  return result;
}

/** v4 batch association reads for every record that is due for evaluation. */
export function planAssociationReads(config, records, now) {
  const requests = [];
  for (const rule of enabledRules(config)) {
    const bucket = records[rule.key] || { records: [] };
    const ids = bucket.records.filter((record) => classifyRecord(record, rule, now, config.settings) === 'evaluate').map((record) => record.id);
    if (!ids.length) continue;
    for (const toObjectType of requiredObjectTypes(rule)) {
      for (const group of chunk(ids, config.settings.batchSize)) {
        requests.push({
          stage: 'associations',
          ruleKey: rule.key,
          fromObjectType: rule.objectTypeId,
          toObjectType,
          request: {
            method: 'POST',
            url: hubspotUrl(config, `/crm/v4/associations/${encodeURIComponent(rule.objectTypeId)}/${encodeURIComponent(toObjectType)}/batch/read`),
            body: { inputs: group.map((id) => ({ id })) },
          },
        });
      }
    }
  }
  return requests;
}

function errorContextIds(error) {
  const context = (error && error.context) || {};
  const ids = [];
  for (const key of ['fromObjectId', 'ids', 'id', 'objectId']) {
    const value = context[key];
    if (Array.isArray(value)) ids.push(...value.map(String));
    else if (value !== undefined && value !== null) ids.push(String(value));
  }
  return ids;
}

export function isNoAssociationsError(error) {
  return /NO_ASSOCIATIONS/i.test(String((error && error.subCategory) || '')) || /no .*associat/i.test(String((error && error.message) || ''));
}

export function isNotFoundError(error) {
  return /NOT_FOUND/i.test(String((error && error.category) || '')) || /not found|could not get|do(?:es)? not exist/i.test(String((error && error.message) || ''));
}

/**
 * Parses a v4 batch read response. Records that HubSpot reports as having no associations count
 * as zero associations. Any other per-record error marks the record as unverifiable, so it is
 * never flagged on incomplete data.
 */
export function tagAssociationResponse(plan, body) {
  if (!body || (!Array.isArray(body.results) && !Array.isArray(body.errors))) {
    throw new Error(`Unexpected HubSpot association response for ${plan.fromObjectType} -> ${plan.toObjectType}`);
  }
  const requested = plan.request.body.inputs.map((input) => String(input.id));
  const byFromId = {};
  const truncatedIds = {};
  const errorIds = {};
  for (const result of body.results || []) {
    const fromId = String(result.from && result.from.id);
    const list = byFromId[fromId] || (byFromId[fromId] = []);
    for (const to of result.to || []) {
      list.push({
        toObjectId: String(to.toObjectId),
        types: (to.associationTypes || []).map((type) => ({ category: type.category, typeId: Number(type.typeId), label: type.label ?? null })),
      });
    }
    if (result.paging && result.paging.next) truncatedIds[fromId] = true;
  }
  for (const error of body.errors || []) {
    if (isNoAssociationsError(error)) continue;
    const ids = errorContextIds(error);
    const affected = ids.length ? ids : requested.filter((id) => !byFromId[id]);
    for (const id of affected) errorIds[id] = true;
  }
  return {
    stage: 'associations',
    ruleKey: plan.ruleKey,
    fromObjectType: plan.fromObjectType,
    toObjectType: plan.toObjectType,
    requested,
    byFromId,
    truncatedIds,
    errorIds,
  };
}

/** Batch reads of associated parent records, to catch deleted parents and parent criteria (targetWhen). */
export function planTargetVerification(config, records, associationResponses) {
  const byType = {};
  for (const rule of enabledRules(config)) {
    if (!records[rule.key]) continue;
    for (const requirement of rule.requirements) {
      if (!requirement.verifyTargets) continue;
      const entry = byType[requirement.toObjectType] || (byType[requirement.toObjectType] = { ids: new Set(), properties: new Set() });
      for (const condition of requirement.targetWhen) entry.properties.add(condition.property);
      for (const response of associationResponses) {
        if (response.ruleKey !== rule.key || response.toObjectType !== requirement.toObjectType) continue;
        for (const list of Object.values(response.byFromId)) {
          for (const association of list) if (matchesAssociationType(association, requirement)) entry.ids.add(association.toObjectId);
        }
      }
    }
  }
  const requests = [];
  for (const toObjectType of Object.keys(byType).sort()) {
    const entry = byType[toObjectType];
    const ids = [...entry.ids].sort(compareIds);
    if (!ids.length) continue;
    const properties = entry.properties.size ? [...entry.properties].sort() : ['hs_object_id'];
    for (const group of chunk(ids, config.settings.batchSize)) {
      requests.push({
        stage: 'targets',
        toObjectType,
        request: {
          method: 'POST',
          url: hubspotUrl(config, `/crm/v3/objects/${encodeURIComponent(toObjectType)}/batch/read`),
          body: { inputs: group.map((id) => ({ id })), properties },
        },
      });
    }
  }
  return requests;
}

/** Missing IDs count as deleted parents. Other errors make the target "unknown" (treated as valid). */
export function tagTargetResponse(plan, body) {
  if (!body || (!Array.isArray(body.results) && !Array.isArray(body.errors))) {
    throw new Error(`Unexpected HubSpot batch read response for ${plan.toObjectType}`);
  }
  const requested = plan.request.body.inputs.map((input) => String(input.id));
  const found = {};
  const unknown = {};
  for (const result of body.results || []) found[String(result.id)] = result.properties || {};
  for (const error of body.errors || []) {
    if (isNotFoundError(error)) continue;
    const ids = errorContextIds(error);
    const affected = ids.length ? ids : requested.filter((id) => found[id] === undefined);
    for (const id of affected) unknown[id] = true;
  }
  return { stage: 'targets', toObjectType: plan.toObjectType, requested, found, unknown };
}

/** Throws when a stage returned fewer responses than it planned, so a partial read never produces flags. */
export function assertStageComplete(stage, expected, received) {
  if (expected !== received) {
    throw new Error(`Integrity guard stopped: the ${stage} stage planned ${expected} request(s) but received ${received} response(s). No flags were written.`);
  }
}

export function assembleDataset({ config, pages, associationResponses = [], targetResponses = [] }) {
  const records = assembleRecords(pages, config);
  const associations = {};
  for (const response of associationResponses) {
    const ruleBucket = associations[response.ruleKey] || (associations[response.ruleKey] = {});
    const entry = ruleBucket[response.toObjectType] || (ruleBucket[response.toObjectType] = { requested: {}, byFromId: {}, truncatedIds: {}, errorIds: {} });
    for (const id of response.requested) entry.requested[id] = true;
    for (const [id, list] of Object.entries(response.byFromId)) entry.byFromId[id] = (entry.byFromId[id] || []).concat(list);
    Object.assign(entry.truncatedIds, response.truncatedIds);
    Object.assign(entry.errorIds, response.errorIds);
  }
  const targets = {};
  for (const response of targetResponses) {
    const entry = targets[response.toObjectType] || (targets[response.toObjectType] = { requested: {}, found: {}, unknown: {} });
    for (const id of response.requested) entry.requested[id] = true;
    Object.assign(entry.found, response.found);
    Object.assign(entry.unknown, response.unknown);
  }
  return { records, associations, targets };
}

export function buildFlagUpdateRequests(updates, config) {
  const byType = {};
  for (const update of updates) (byType[update.objectTypeId] || (byType[update.objectTypeId] = [])).push(update);
  const requests = [];
  for (const objectTypeId of Object.keys(byType)) {
    for (const group of chunk(byType[objectTypeId], config.settings.batchSize)) {
      requests.push({
        stage: 'flags',
        objectTypeId,
        request: {
          method: 'POST',
          url: hubspotUrl(config, `/crm/v3/objects/${encodeURIComponent(objectTypeId)}/batch/update`),
          body: { inputs: group.map((update) => ({ id: update.id, properties: update.properties })) },
        },
      });
    }
  }
  return requests;
}

export function tagFlagWriteResponse(plan, body) {
  const attempted = plan.request.body.inputs.length;
  const updated = Math.min(attempted, body && Array.isArray(body.results) ? body.results.length : 0);
  return { stage: 'flags', objectTypeId: plan.objectTypeId, attempted, updated, failed: attempted - updated };
}

export function summarizeFlagWrites(tags) {
  return tags.reduce((summary, tag) => ({
    executed: true,
    batches: summary.batches + 1,
    attempted: summary.attempted + tag.attempted,
    updated: summary.updated + tag.updated,
    failed: summary.failed + tag.failed,
  }), { executed: tags.length > 0, batches: 0, attempted: 0, updated: 0, failed: 0 });
}

/* ---------- read-only discovery and one-time property setup (CLI scripts only) ---------- */

export function buildSchemasRequest(config) {
  return { method: 'GET', url: hubspotUrl(config, '/crm/v3/schemas') };
}

export function buildAssociationLabelsRequest(config, fromObjectType, toObjectType) {
  return { method: 'GET', url: hubspotUrl(config, `/crm/v4/associations/${encodeURIComponent(fromObjectType)}/${encodeURIComponent(toObjectType)}/labels`) };
}

export function buildPropertyGroupsRequest(config, objectTypeId) {
  return { method: 'GET', url: hubspotUrl(config, `/crm/v3/properties/${encodeURIComponent(objectTypeId)}/groups`) };
}

export function buildFlagPropertyRequests(config, rule, groupName) {
  if (!rule.flag) return [];
  const url = hubspotUrl(config, `/crm/v3/properties/${encodeURIComponent(rule.objectTypeId)}`);
  const requests = [{
    method: 'POST',
    url,
    body: {
      name: rule.flag.status,
      label: 'Association Integrity Status',
      description: 'Set by the association integrity guard. Blank means the record has never been flagged.',
      groupName,
      type: 'enumeration',
      fieldType: 'select',
      options: [
        { label: 'Healthy', value: 'healthy', displayOrder: 0 },
        { label: 'At risk', value: 'at_risk', displayOrder: 1 },
        { label: 'Conflict', value: 'conflict', displayOrder: 2 },
        { label: 'Orphaned', value: 'orphaned', displayOrder: 3 },
      ],
    },
  }];
  if (rule.flag.issues) {
    requests.push({ method: 'POST', url, body: { name: rule.flag.issues, label: 'Association Integrity Issues', description: 'Plain-language list of the association rules this record breaks.', groupName, type: 'string', fieldType: 'textarea' } });
  }
  if (rule.flag.checkedAt) {
    requests.push({ method: 'POST', url, body: { name: rule.flag.checkedAt, label: 'Association Integrity Checked At', description: 'When the guard last changed this record\'s integrity flag.', groupName, type: 'datetime', fieldType: 'date' } });
  }
  return requests;
}
