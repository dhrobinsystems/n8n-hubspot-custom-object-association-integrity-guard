/**
 * Configuration loading and validation for the association integrity guard.
 *
 * Every switch fails safe:
 * - DRY_RUN and SANDBOX_MODE stay on unless they are explicitly set to false/0/no/off.
 * - FLAG_WRITES_ENABLED stays off unless it is explicitly set to true/1/yes/on.
 * - A placeholder HubSpot token switches the guard into demo mode (bundled mock data, no network).
 * - Live mode (DRY_RUN=false and SANDBOX_MODE=false) refuses to start while placeholders remain.
 */

export const DEFAULT_HUBSPOT_BASE_URL = 'https://api.hubapi.com';
export const SANDBOX_ACCOUNT_TYPES = Object.freeze(['SANDBOX', 'DEVELOPER_TEST']);
export const SEVERITIES = Object.freeze(['critical', 'warning']);
export const ASSOCIATION_CATEGORIES = Object.freeze(['HUBSPOT_DEFINED', 'USER_DEFINED', 'INTEGRATOR_DEFINED']);
export const SLACK_WEBHOOK_PREFIX = 'https://hooks.slack.com/';

export const DEFAULT_FLAG_PROPERTIES = Object.freeze({
  status: 'association_integrity_status',
  issues: 'association_integrity_issues',
  checkedAt: 'association_integrity_checked_at',
});

export const DEFAULT_SETTINGS = Object.freeze({
  gracePeriodHours: 24,
  maxRecordsPerObject: 10000,
  pageSize: 100,
  batchSize: 100,
  maxFlagUpdatesPerRun: 200,
  orphanRateCircuitBreaker: 0.5,
  circuitBreakerMinSample: 20,
  verifyTargetsExist: true,
});

const SETTING_LIMITS = Object.freeze({
  gracePeriodHours: { env: 'GRACE_PERIOD_HOURS', min: 0, max: 8760 },
  maxRecordsPerObject: { env: 'MAX_RECORDS_PER_OBJECT', min: 1, max: 1000000, integer: true },
  pageSize: { env: 'HUBSPOT_PAGE_SIZE', min: 1, max: 100, integer: true },
  batchSize: { env: 'HUBSPOT_BATCH_SIZE', min: 1, max: 100, integer: true },
  maxFlagUpdatesPerRun: { env: 'MAX_FLAG_UPDATES_PER_RUN', min: 0, max: 100000, integer: true },
  orphanRateCircuitBreaker: { env: 'ORPHAN_RATE_CIRCUIT_BREAKER', min: 0.01, max: 1 },
  circuitBreakerMinSample: { env: 'CIRCUIT_BREAKER_MIN_SAMPLE', min: 1, max: 1000000, integer: true },
});

const STANDARD_OBJECT_LABELS = Object.freeze({
  companies: 'Company',
  deals: 'Deal',
  contacts: 'Contact',
  tickets: 'Ticket',
});

const PLACEHOLDER_PATTERN = /^(?:|your_[a-z0-9_]*_here|changeme|change_me|placeholder|x{3,})$/i;
const EMBEDDED_PLACEHOLDER_PATTERN = /your_[a-z0-9_]*_here/i;
const OBJECT_TYPE_PATTERN = /^(?:\d+-\d+|[a-z][a-z0-9_]*)$/i;

/** True for empty values and for template placeholders such as YOUR_HUBSPOT_PRIVATE_APP_TOKEN_HERE. */
export function isPlaceholder(value) {
  if (value === undefined || value === null) return true;
  const text = String(value).trim();
  return PLACEHOLDER_PATTERN.test(text) || EMBEDDED_PLACEHOLDER_PATTERN.test(text);
}

/** Reads a boolean switch. Anything that is not a recognised true/false word keeps the safe fallback. */
export function readBooleanEnv(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim().toLowerCase();
  if (text === '') return fallback;
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  return fallback;
}

export function isValidObjectType(value) {
  return typeof value === 'string' && OBJECT_TYPE_PATTERN.test(value.trim());
}

function describeLimits(limits) {
  const kind = limits.integer ? 'an integer' : 'a number';
  return `must be ${kind} between ${limits.min} and ${limits.max}`;
}

function withinLimits(number, limits) {
  if (!Number.isFinite(number)) return false;
  if (limits.integer && !Number.isInteger(number)) return false;
  return number >= limits.min && number <= limits.max;
}

function readNumber(raw, fallback, limits, name, problems) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const number = Number(String(raw).trim());
  if (!withinLimits(number, limits)) {
    problems.push(`${name} ${describeLimits(limits)} (received "${raw}")`);
    return fallback;
  }
  return number;
}

function parseGuardDocument(raw, problems) {
  if (raw === undefined || raw === null || isPlaceholder(raw)) return null;
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      problems.push('GUARD_CONFIG_JSON must be a JSON object with "rules", "associationTypes" and optional "settings"');
      return null;
    }
    return parsed;
  } catch (error) {
    problems.push(`GUARD_CONFIG_JSON is not valid JSON (${error.message})`);
    return null;
  }
}

function asStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry).trim()).filter(Boolean);
}

export function normalizeConditions(raw, context, problems) {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    problems.push(`${context} must be an array of conditions`);
    return [];
  }
  const conditions = [];
  raw.forEach((entry, index) => {
    const where = `${context}[${index}]`;
    if (!entry || typeof entry !== 'object' || typeof entry.property !== 'string' || !entry.property.trim()) {
      problems.push(`${where} needs a "property" name`);
      return;
    }
    const operators = ['in', 'notIn', 'isEmpty'].filter((key) => entry[key] !== undefined);
    if (operators.length !== 1) {
      problems.push(`${where} needs exactly one of "in", "notIn" or "isEmpty"`);
      return;
    }
    const condition = { property: entry.property.trim() };
    if (operators[0] === 'isEmpty') {
      if (typeof entry.isEmpty !== 'boolean') {
        problems.push(`${where}.isEmpty must be true or false`);
        return;
      }
      condition.isEmpty = entry.isEmpty;
    } else {
      if (!Array.isArray(entry[operators[0]])) {
        problems.push(`${where}.${operators[0]} must be an array of values`);
        return;
      }
      condition[operators[0]] = entry[operators[0]].map((value) => String(value).trim());
    }
    conditions.push(condition);
  });
  return conditions;
}

function defaultTargetLabel(toObjectType) {
  return STANDARD_OBJECT_LABELS[toObjectType] || toObjectType || 'record';
}

function parseInteger(value) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  return Number.isInteger(number) ? number : NaN;
}

function normalizeRequirement(raw, index, rule, associationTypes, settings, problems) {
  const where = `rule "${rule.key}" requirement ${index + 1}`;
  const source = raw && typeof raw === 'object' ? raw : {};
  let typeRef = null;
  if (source.associationType !== undefined && source.associationType !== null) {
    typeRef = associationTypes[source.associationType] || null;
    if (!typeRef) problems.push(`${where}: unknown associationType "${source.associationType}"`);
  }
  const toObjectType = String(source.toObjectType ?? (typeRef && typeRef.toObjectType) ?? '').trim();
  const typeIdRaw = source.associationTypeId ?? (typeRef ? typeRef.typeId : null);
  let associationTypeId = null;
  let associationTypeIdPlaceholder = false;
  if (typeIdRaw !== null && typeIdRaw !== undefined && String(typeIdRaw).trim() !== '') {
    if (isPlaceholder(typeIdRaw)) {
      associationTypeIdPlaceholder = true;
    } else {
      const parsed = parseInteger(typeIdRaw);
      if (Number.isNaN(parsed) || parsed < 1) problems.push(`${where}: associationTypeId must be a positive integer (received ${JSON.stringify(typeIdRaw)})`);
      else associationTypeId = parsed;
    }
  }
  const hasTypeId = associationTypeId !== null || associationTypeIdPlaceholder;
  const associationCategory = String(source.associationCategory || (typeRef && typeRef.category) || (hasTypeId ? 'USER_DEFINED' : '')).trim().toUpperCase() || null;
  if (associationCategory && !ASSOCIATION_CATEGORIES.includes(associationCategory)) {
    problems.push(`${where}: associationCategory must be one of ${ASSOCIATION_CATEGORIES.join(', ')}`);
  }
  if (typeRef && typeRef.fromObjectType && !isPlaceholder(typeRef.fromObjectType) && !isPlaceholder(rule.objectTypeId) && String(typeRef.fromObjectType).trim() !== rule.objectTypeId) {
    problems.push(`${where}: associationType "${source.associationType}" is defined from ${typeRef.fromObjectType}, but the rule audits ${rule.objectTypeId}`);
  }
  const min = source.min === undefined ? 1 : parseInteger(source.min);
  const max = source.max === undefined || source.max === null ? null : parseInteger(source.max);
  if (Number.isNaN(min) || min < 0) problems.push(`${where}: min must be an integer of 0 or more`);
  if (max !== null && (Number.isNaN(max) || max < 0)) problems.push(`${where}: max must be an integer of 0 or more`);
  if (Number.isInteger(min) && Number.isInteger(max) && max < min) problems.push(`${where}: max (${max}) is lower than min (${min})`);
  if (min === 0 && max === null) problems.push(`${where}: min 0 with no max can never fail; set min of 1 or more, or a max`);
  const severity = String(source.severity || 'critical').trim().toLowerCase();
  if (!SEVERITIES.includes(severity)) problems.push(`${where}: severity must be "critical" or "warning"`);
  const targetWhen = normalizeConditions(source.targetWhen, `${where}.targetWhen`, problems);
  const requirement = {
    key: String(source.key || `${toObjectType || 'requirement'}_${index + 1}`).trim(),
    label: String(source.label || defaultTargetLabel(toObjectType)).trim(),
    toObjectType,
    associationTypeId,
    associationTypeIdPlaceholder,
    associationCategory,
    associationLabel: source.associationLabel || (typeRef && typeRef.label) || null,
    min: Number.isInteger(min) ? min : 1,
    max: Number.isInteger(max) ? max : null,
    severity: SEVERITIES.includes(severity) ? severity : 'critical',
    when: normalizeConditions(source.when, `${where}.when`, problems),
    targetWhen,
  };
  requirement.verifyTargets = settings.verifyTargetsExist || targetWhen.length > 0;
  return requirement;
}

export function normalizeRules(rawRules, associationTypes, settings, problems) {
  if (rawRules === undefined || rawRules === null) return [];
  if (!Array.isArray(rawRules)) {
    problems.push('"rules" must be an array');
    return [];
  }
  const seenKeys = new Set();
  return rawRules.map((raw, index) => {
    const source = raw && typeof raw === 'object' ? raw : {};
    const objectTypeId = String(source.objectTypeId ?? '').trim();
    const key = String(source.key || objectTypeId || `rule_${index + 1}`).trim();
    if (seenKeys.has(key)) problems.push(`rule key "${key}" is used more than once`);
    seenKeys.add(key);
    const rule = {
      key,
      label: String(source.label || key).trim(),
      objectTypeId,
      enabled: source.enabled !== false,
      displayProperty: source.displayProperty ? String(source.displayProperty).trim() : null,
      properties: asStringList(source.properties),
      onlyWhen: [],
      skipWhen: [],
      flag: null,
      requirements: [],
    };
    rule.onlyWhen = normalizeConditions(source.onlyWhen, `rule "${key}".onlyWhen`, problems);
    rule.skipWhen = normalizeConditions(source.skipWhen, `rule "${key}".skipWhen`, problems);
    if (source.flag !== false) {
      const flag = source.flag && typeof source.flag === 'object' ? source.flag : {};
      const pick = (name, fallback) => (flag[name] === null ? null : String(flag[name] || fallback || '').trim() || null);
      rule.flag = {
        status: pick('statusProperty', settings.flagProperties.status),
        issues: pick('issuesProperty', settings.flagProperties.issues),
        checkedAt: pick('checkedAtProperty', settings.flagProperties.checkedAt),
      };
      if (!rule.flag.status) rule.flag = null;
    }
    const requirements = Array.isArray(source.requirements) ? source.requirements : [];
    if (!Array.isArray(source.requirements)) problems.push(`rule "${key}" needs a "requirements" array`);
    rule.requirements = requirements.map((entry, j) => normalizeRequirement(entry, j, rule, associationTypes, settings, problems));
    const requirementKeys = new Set();
    for (const requirement of rule.requirements) {
      if (requirementKeys.has(requirement.key)) problems.push(`rule "${key}" uses requirement key "${requirement.key}" more than once`);
      requirementKeys.add(requirement.key);
    }
    return rule;
  });
}

/**
 * Builds the runtime configuration from environment variables (n8n `$env` or `process.env`).
 * options.guardDocument replaces GUARD_CONFIG_JSON (used by the CLI and by demo mode).
 * options.forceMode pins the mode ("demo" or "hubspot").
 */
export function loadGuardConfig(env = {}, options = {}) {
  const source = env || {};
  const problems = [];
  const read = (name) => {
    const value = source[name];
    return value === undefined || value === null ? undefined : String(value);
  };
  const token = (read('HUBSPOT_PRIVATE_APP_TOKEN') || '').trim();
  const document = options.guardDocument !== undefined ? options.guardDocument : parseGuardDocument(read('GUARD_CONFIG_JSON'), problems);
  const fileSettings = document && document.settings && typeof document.settings === 'object' ? document.settings : {};

  const settings = {};
  for (const [name, limits] of Object.entries(SETTING_LIMITS)) {
    let fallback = DEFAULT_SETTINGS[name];
    if (fileSettings[name] !== undefined) {
      const number = Number(fileSettings[name]);
      if (withinLimits(number, limits)) fallback = number;
      else problems.push(`settings.${name} ${describeLimits(limits)} (received ${JSON.stringify(fileSettings[name])})`);
    }
    settings[name] = readNumber(read(limits.env), fallback, limits, limits.env, problems);
  }
  const fileVerify = typeof fileSettings.verifyTargetsExist === 'boolean' ? fileSettings.verifyTargetsExist : DEFAULT_SETTINGS.verifyTargetsExist;
  settings.verifyTargetsExist = readBooleanEnv(read('VERIFY_TARGETS_EXIST'), fileVerify);
  const flagProperties = { ...DEFAULT_FLAG_PROPERTIES };
  if (fileSettings.flagProperties && typeof fileSettings.flagProperties === 'object') {
    for (const name of Object.keys(DEFAULT_FLAG_PROPERTIES)) {
      const value = fileSettings.flagProperties[name];
      if (typeof value === 'string' && value.trim()) flagProperties[name] = value.trim();
    }
  }
  settings.flagProperties = flagProperties;

  const associationTypes = document && document.associationTypes && typeof document.associationTypes === 'object' && !Array.isArray(document.associationTypes)
    ? document.associationTypes
    : {};
  const rules = normalizeRules(document ? document.rules : [], associationTypes, settings, problems);

  const nowOverride = (read('AUDIT_NOW') || '').trim() || null;
  if (nowOverride && !Number.isFinite(Date.parse(nowOverride))) problems.push(`AUDIT_NOW must be an ISO 8601 timestamp (received "${nowOverride}")`);

  return {
    mode: options.forceMode || (isPlaceholder(token) ? 'demo' : 'hubspot'),
    dryRun: readBooleanEnv(read('DRY_RUN'), true),
    sandboxMode: readBooleanEnv(read('SANDBOX_MODE'), true),
    flagWritesEnabled: readBooleanEnv(read('FLAG_WRITES_ENABLED'), false),
    hubspot: {
      token,
      baseUrl: ((read('HUBSPOT_BASE_URL') || '').trim() || DEFAULT_HUBSPOT_BASE_URL).replace(/\/+$/, ''),
      sandboxPortalId: (read('HUBSPOT_SANDBOX_PORTAL_ID') || '').trim(),
    },
    slack: {
      webhookUrl: (read('SLACK_WEBHOOK_URL') || '').trim(),
      sandboxWebhookUrl: (read('SLACK_SANDBOX_WEBHOOK_URL') || '').trim(),
      alertOnCleanRun: readBooleanEnv(read('ALERT_ON_CLEAN_RUN'), false),
      includeRecordNames: readBooleanEnv(read('SLACK_INCLUDE_RECORD_NAMES'), false),
      maxSamples: readNumber(read('SLACK_MAX_SAMPLES'), 10, { min: 0, max: 25, integer: true }, 'SLACK_MAX_SAMPLES', problems),
    },
    settings,
    associationTypes,
    rules,
    nowOverride,
    documentLoaded: Boolean(document),
    problems,
  };
}

export function enabledRules(config) {
  return config.rules.filter((rule) => rule.enabled);
}

export function isLiveMode(config) {
  return !config.dryRun && !config.sandboxMode;
}

function usableWebhook(url) {
  return !isPlaceholder(url) && String(url).startsWith(SLACK_WEBHOOK_PREFIX);
}

/** Decides where an alert may go. It never returns the URL itself, so the URL stays out of n8n item data. */
export function resolveSlackTarget(config) {
  if (isLiveMode(config)) {
    return usableWebhook(config.slack.webhookUrl)
      ? { target: 'production', reason: 'live mode: alerts go to SLACK_WEBHOOK_URL' }
      : { target: 'preview', reason: 'SLACK_WEBHOOK_URL is not configured, so the alert is only logged' };
  }
  return usableWebhook(config.slack.sandboxWebhookUrl)
    ? { target: 'sandbox', reason: 'DRY_RUN or SANDBOX_MODE is on, so alerts go to SLACK_SANDBOX_WEBHOOK_URL' }
    : { target: 'preview', reason: 'DRY_RUN or SANDBOX_MODE is on and SLACK_SANDBOX_WEBHOOK_URL is not configured, so the alert is only logged' };
}

export function describeSafety(config) {
  return {
    mode: config.mode,
    dryRun: config.dryRun,
    sandboxMode: config.sandboxMode,
    flagWritesEnabled: config.flagWritesEnabled,
    writesPossible: !config.dryRun && config.flagWritesEnabled,
    slackTarget: resolveSlackTarget(config).target,
  };
}

export function resolveNow(config) {
  if (config.nowOverride) {
    const parsed = Date.parse(config.nowOverride);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

/** Returns { errors, warnings }. Any error must stop the run before it touches HubSpot. */
export function validateGuardConfig(config) {
  const errors = [...config.problems];
  const warnings = [];
  const live = isLiveMode(config);

  for (const [name, url] of [['SLACK_WEBHOOK_URL', config.slack.webhookUrl], ['SLACK_SANDBOX_WEBHOOK_URL', config.slack.sandboxWebhookUrl]]) {
    if (!isPlaceholder(url) && !String(url).startsWith(SLACK_WEBHOOK_PREFIX)) errors.push(`${name} must start with ${SLACK_WEBHOOK_PREFIX}`);
  }

  if (config.mode === 'demo') {
    if (live) errors.push('Live mode (DRY_RUN=false and SANDBOX_MODE=false) needs a real HUBSPOT_PRIVATE_APP_TOKEN. Replace the placeholder or turn DRY_RUN back on.');
    warnings.push('HUBSPOT_PRIVATE_APP_TOKEN is a placeholder, so the guard runs against its bundled demo dataset and makes no HubSpot calls.');
    return { errors, warnings };
  }

  if (!/^https:\/\//.test(config.hubspot.baseUrl)) errors.push('HUBSPOT_BASE_URL must use https://');
  if (!config.documentLoaded) errors.push('GUARD_CONFIG_JSON is missing. Copy config.example.json to config.json, fill in your object type IDs, then run "npm run config:env".');
  const active = enabledRules(config);
  if (config.documentLoaded && active.length === 0) errors.push('GUARD_CONFIG_JSON defines no enabled rules');

  for (const rule of active) {
    if (isPlaceholder(rule.objectTypeId)) errors.push(`rule "${rule.key}": objectTypeId is still a placeholder`);
    else if (!isValidObjectType(rule.objectTypeId)) errors.push(`rule "${rule.key}": objectTypeId "${rule.objectTypeId}" is not a valid object type (use an ID such as 2-1234567 or a name such as deals)`);
    if (rule.requirements.length === 0) errors.push(`rule "${rule.key}" has no requirements`);
    const propertyNames = [
      ['displayProperty', rule.displayProperty],
      ...rule.properties.map((name) => ['properties', name]),
      ...rule.onlyWhen.map((condition) => ['onlyWhen', condition.property]),
      ...rule.skipWhen.map((condition) => ['skipWhen', condition.property]),
      ...rule.requirements.flatMap((requirement) => [...requirement.when, ...requirement.targetWhen].map((condition) => [`requirement "${requirement.key}" condition`, condition.property])),
    ];
    for (const [where, name] of propertyNames) {
      if (name !== null && isPlaceholder(name)) errors.push(`rule "${rule.key}" ${where}: property name is still a placeholder`);
    }
    for (const requirement of rule.requirements) {
      const where = `rule "${rule.key}" requirement "${requirement.key}"`;
      if (isPlaceholder(requirement.toObjectType)) errors.push(`${where}: toObjectType is missing or still a placeholder`);
      else if (!isValidObjectType(requirement.toObjectType)) errors.push(`${where}: toObjectType "${requirement.toObjectType}" is not a valid object type`);
      if (requirement.associationTypeIdPlaceholder) errors.push(`${where}: associationTypeId is still a placeholder (run "npm run discover" to list the label IDs)`);
    }
  }

  if (!isPlaceholder(config.hubspot.sandboxPortalId) && !/^\d+$/.test(config.hubspot.sandboxPortalId)) {
    errors.push('HUBSPOT_SANDBOX_PORTAL_ID must be numeric when it is set');
  }
  if (live && isPlaceholder(config.slack.webhookUrl)) warnings.push('Live mode without SLACK_WEBHOOK_URL: findings are only logged.');
  if (!config.dryRun && !config.flagWritesEnabled) warnings.push('DRY_RUN=false but FLAG_WRITES_ENABLED is not true, so the guard reports findings without writing flags.');
  if (!config.dryRun && config.flagWritesEnabled && active.every((rule) => !rule.flag)) warnings.push('FLAG_WRITES_ENABLED=true but every rule has "flag": false, so nothing is written.');
  return { errors, warnings };
}
