/**
 * The integrity engine: pure functions that turn records, associations and target lookups
 * into findings, a report and a flag-write plan. No network access happens here.
 */
import { enabledRules, describeSafety } from './config.js';

export const STATUS = Object.freeze({
  HEALTHY: 'healthy',
  UNVERIFIED: 'unverified',
  AT_RISK: 'at_risk',
  CONFLICT: 'conflict',
  ORPHANED: 'orphaned',
});

export const STATUS_RANK = Object.freeze({ healthy: 0, unverified: 1, at_risk: 2, conflict: 3, orphaned: 4 });

export const MISSING_CODES = Object.freeze([
  'missing_association',
  'label_mismatch',
  'dangling_association',
  'invalid_parent',
  'insufficient_associations',
]);

const ISSUES_MAX_LENGTH = 1000;

export function propertyValue(properties, name) {
  if (!properties) return '';
  const raw = properties[name];
  return raw === undefined || raw === null ? '' : String(raw).trim();
}

export function matchesCondition(properties, condition) {
  const value = propertyValue(properties, condition.property);
  if (condition.isEmpty !== undefined) return condition.isEmpty ? value === '' : value !== '';
  if (Array.isArray(condition.in)) return condition.in.includes(value);
  if (Array.isArray(condition.notIn)) return !condition.notIn.includes(value);
  return false;
}

export function matchesAllConditions(properties, conditions) {
  return (conditions || []).every((condition) => matchesCondition(properties, condition));
}

export function matchesAnyCondition(properties, conditions) {
  return (conditions || []).some((condition) => matchesCondition(properties, condition));
}

export function recordCreatedAt(record) {
  const raw = record.createdAt || (record.properties && record.properties.hs_createdate);
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Returns "excluded", "grace" or "evaluate". */
export function classifyRecord(record, rule, now, settings) {
  if (rule.onlyWhen.length && !matchesAllConditions(record.properties, rule.onlyWhen)) return 'excluded';
  if (rule.skipWhen.length && matchesAnyCondition(record.properties, rule.skipWhen)) return 'excluded';
  const created = recordCreatedAt(record);
  if (created !== null && settings.gracePeriodHours > 0 && now - created < settings.gracePeriodHours * 3600000) return 'grace';
  return 'evaluate';
}

export function requiredObjectTypes(rule) {
  return [...new Set(rule.requirements.map((requirement) => requirement.toObjectType))];
}

export function matchesAssociationType(association, requirement) {
  if (requirement.associationTypeId === null || requirement.associationTypeId === undefined) return true;
  return (association.types || []).some((type) => Number(type.typeId) === requirement.associationTypeId
    && (!requirement.associationCategory || type.category === requirement.associationCategory));
}

/** Evaluates one requirement for one record and returns a violation or null. */
export function evaluateRequirement(record, requirement, associations, targetIndex) {
  if (requirement.when.length && !matchesAllConditions(record.properties, requirement.when)) return null;
  const all = associations || [];
  const labeled = all.filter((association) => matchesAssociationType(association, requirement));
  let dangling = 0;
  let invalid = 0;
  let valid = 0;
  for (const association of labeled) {
    const id = String(association.toObjectId);
    if (requirement.verifyTargets && targetIndex && targetIndex.requested[id] && !targetIndex.unknown[id]) {
      const properties = targetIndex.found[id];
      if (properties === undefined) {
        dangling += 1;
        continue;
      }
      if (requirement.targetWhen.length && !matchesAllConditions(properties, requirement.targetWhen)) {
        invalid += 1;
        continue;
      }
    }
    valid += 1;
  }
  const base = {
    requirementKey: requirement.key,
    requirementLabel: requirement.label,
    toObjectType: requirement.toObjectType,
    associationLabel: requirement.associationLabel,
    severity: requirement.severity,
    min: requirement.min,
    max: requirement.max,
    validCount: valid,
    associatedCount: all.length,
    labeledCount: labeled.length,
    danglingCount: dangling,
    invalidCount: invalid,
  };
  if (valid < requirement.min) {
    let code = 'insufficient_associations';
    if (all.length === 0) code = 'missing_association';
    else if (labeled.length === 0) code = 'label_mismatch';
    else if (dangling > 0) code = 'dangling_association';
    else if (invalid > 0) code = 'invalid_parent';
    return { code, ...base };
  }
  if (requirement.max !== null && valid > requirement.max) return { code: 'too_many_associations', ...base };
  return null;
}

export function statusFromViolations(violations) {
  const critical = violations.filter((violation) => violation.severity === 'critical');
  if (critical.some((violation) => MISSING_CODES.includes(violation.code))) return STATUS.ORPHANED;
  if (critical.length) return STATUS.CONFLICT;
  if (violations.length) return STATUS.AT_RISK;
  return STATUS.HEALTHY;
}

export function describeViolation(violation) {
  const target = violation.requirementLabel;
  const labelText = violation.associationLabel ? ` labelled "${violation.associationLabel}"` : '';
  const need = `needs at least ${violation.min}`;
  switch (violation.code) {
    case 'missing_association':
      return `${target}: no association (${need})`;
    case 'label_mismatch':
      return `${target}: ${violation.associatedCount} associated but none${labelText} (${need})`;
    case 'dangling_association':
      return `${target}: ${violation.danglingCount} associated record(s) no longer exist (${violation.validCount} valid, ${need})`;
    case 'invalid_parent':
      return `${target}: ${violation.invalidCount} associated record(s) fail the parent criteria (${violation.validCount} valid, ${need})`;
    case 'insufficient_associations':
      return `${target}: ${violation.validCount}${labelText} associated (${need})`;
    case 'too_many_associations':
      return `${target}: ${violation.validCount}${labelText} associated (allows at most ${violation.max})`;
    default:
      return `${target}: ${violation.code}`;
  }
}

export function formatIssues(violations) {
  const text = violations.map(describeViolation).join('; ');
  return text.length > ISSUES_MAX_LENGTH ? `${text.slice(0, ISSUES_MAX_LENGTH - 3)}...` : text;
}

export function evaluateRecord(record, rule, recordAssociations, targets) {
  const violations = [];
  for (const requirement of rule.requirements) {
    const violation = evaluateRequirement(record, requirement, recordAssociations[requirement.toObjectType], targets[requirement.toObjectType]);
    if (violation) violations.push(violation);
  }
  return { status: statusFromViolations(violations), violations };
}

function emptyCounts() {
  return { scanned: 0, evaluated: 0, skippedGrace: 0, skippedExcluded: 0, healthy: 0, atRisk: 0, conflict: 0, orphaned: 0, unverified: 0 };
}

const COUNT_KEY = { healthy: 'healthy', at_risk: 'atRisk', conflict: 'conflict', orphaned: 'orphaned', unverified: 'unverified' };

/**
 * dataset = {
 *   records:      { [ruleKey]: { records: [{ id, createdAt, properties }], truncated } },
 *   associations: { [ruleKey]: { [toObjectType]: { requested, byFromId, truncatedIds, errorIds } } },
 *   targets:      { [toObjectType]: { requested, found, unknown } }
 * }
 */
export function auditDataset({ config, dataset, now, account = null }) {
  const findings = [];
  const cleared = [];
  const ruleSummaries = [];
  const totals = { rules: 0, ...emptyCounts() };

  for (const rule of enabledRules(config)) {
    const bucket = (dataset.records && dataset.records[rule.key]) || { records: [], truncated: false };
    const counts = emptyCounts();
    const violationsByCode = {};
    const ruleAssociations = (dataset.associations && dataset.associations[rule.key]) || {};
    const statusProperty = rule.flag ? rule.flag.status : null;
    const issuesProperty = rule.flag ? rule.flag.issues : null;

    for (const record of bucket.records) {
      counts.scanned += 1;
      const classification = classifyRecord(record, rule, now, config.settings);
      if (classification === 'excluded') { counts.skippedExcluded += 1; continue; }
      if (classification === 'grace') { counts.skippedGrace += 1; continue; }
      counts.evaluated += 1;

      const recordAssociations = {};
      let unverifiable = false;
      let associationsTruncated = false;
      for (const toObjectType of requiredObjectTypes(rule)) {
        const entry = ruleAssociations[toObjectType];
        if (!entry || !entry.requested[record.id] || entry.errorIds[record.id]) {
          unverifiable = true;
          continue;
        }
        recordAssociations[toObjectType] = entry.byFromId[record.id] || [];
        if (entry.truncatedIds[record.id]) associationsTruncated = true;
      }

      const previousStatus = statusProperty ? propertyValue(record.properties, statusProperty) : '';
      const previousIssues = issuesProperty ? propertyValue(record.properties, issuesProperty) : '';
      const result = unverifiable
        ? { status: STATUS.UNVERIFIED, violations: [] }
        : evaluateRecord(record, rule, recordAssociations, dataset.targets || {});
      counts[COUNT_KEY[result.status]] += 1;
      for (const violation of result.violations) violationsByCode[violation.code] = (violationsByCode[violation.code] || 0) + 1;

      const entry = {
        ruleKey: rule.key,
        ruleLabel: rule.label,
        objectTypeId: rule.objectTypeId,
        id: record.id,
        status: result.status,
        previousStatus,
        previousIssues,
        display: rule.displayProperty ? propertyValue(record.properties, rule.displayProperty) || null : null,
        createdAt: record.createdAt || null,
        associationsTruncated,
        violations: result.violations,
      };
      if (result.status !== STATUS.HEALTHY) findings.push(entry);
      else if (previousStatus && previousStatus !== STATUS.HEALTHY) cleared.push(entry);
    }

    const orphanRate = counts.evaluated ? counts.orphaned / counts.evaluated : 0;
    const tripped = counts.evaluated >= config.settings.circuitBreakerMinSample && orphanRate > config.settings.orphanRateCircuitBreaker;
    ruleSummaries.push({
      key: rule.key,
      label: rule.label,
      objectTypeId: rule.objectTypeId,
      ...counts,
      orphanRate: Math.round(orphanRate * 10000) / 10000,
      truncated: Boolean(bucket.truncated),
      violationsByCode,
      circuitBreaker: {
        tripped,
        reason: tripped
          ? `${Math.round(orphanRate * 100)}% of evaluated ${rule.label} records look orphaned (threshold ${Math.round(config.settings.orphanRateCircuitBreaker * 100)}%). That usually means a wrong object type or association label ID, so flag writes for this object are suppressed.`
          : null,
      },
    });
    totals.rules += 1;
    for (const key of Object.keys(counts)) totals[key] += counts[key];
  }

  const ruleOrder = Object.fromEntries(ruleSummaries.map((summary, index) => [summary.key, index]));
  findings.sort((a, b) => (STATUS_RANK[b.status] - STATUS_RANK[a.status]) || (ruleOrder[a.ruleKey] - ruleOrder[b.ruleKey]) || compareIds(a.id, b.id));
  cleared.sort((a, b) => (ruleOrder[a.ruleKey] - ruleOrder[b.ruleKey]) || compareIds(a.id, b.id));

  return {
    runId: `aig-${new Date(now).toISOString().replace(/[:.]/g, '-')}`,
    generatedAt: new Date(now).toISOString(),
    mode: config.mode,
    safety: describeSafety(config),
    account,
    settings: {
      gracePeriodHours: config.settings.gracePeriodHours,
      verifyTargetsExist: config.settings.verifyTargetsExist,
      orphanRateCircuitBreaker: config.settings.orphanRateCircuitBreaker,
      maxFlagUpdatesPerRun: config.settings.maxFlagUpdatesPerRun,
    },
    totals,
    rules: ruleSummaries,
    findings,
    cleared,
  };
}

export function compareIds(a, b) {
  const left = String(a);
  const right = String(b);
  if (/^\d+$/.test(left) && /^\d+$/.test(right) && left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Plans flag writes. Writes are only allowed when DRY_RUN=false and FLAG_WRITES_ENABLED=true.
 * Healthy records that were never flagged are left untouched; previously flagged records that
 * are healthy again are reset to "healthy".
 */
export function planFlagUpdates(report, config) {
  const writesAllowed = !config.dryRun && config.flagWritesEnabled;
  const reason = writesAllowed
    ? 'DRY_RUN=false and FLAG_WRITES_ENABLED=true'
    : config.dryRun
      ? 'DRY_RUN is on, so flag writes are only planned'
      : 'FLAG_WRITES_ENABLED is not true, so flag writes are only planned';
  const rulesByKey = Object.fromEntries(enabledRules(config).map((rule) => [rule.key, rule]));
  const summariesByKey = Object.fromEntries(report.rules.map((summary) => [summary.key, summary]));
  const checkedAt = report.generatedAt;
  const skipped = { unchanged: 0, unverified: 0, noFlagConfig: 0, circuitBreaker: 0, deferredByCap: 0 };
  let updates = [];

  for (const candidate of [...report.findings, ...report.cleared]) {
    if (candidate.status === STATUS.UNVERIFIED) { skipped.unverified += 1; continue; }
    const rule = rulesByKey[candidate.ruleKey];
    if (!rule || !rule.flag) { skipped.noFlagConfig += 1; continue; }
    if (summariesByKey[candidate.ruleKey] && summariesByKey[candidate.ruleKey].circuitBreaker.tripped) { skipped.circuitBreaker += 1; continue; }
    const properties = { [rule.flag.status]: candidate.status };
    if (rule.flag.issues) properties[rule.flag.issues] = formatIssues(candidate.violations);
    const unchanged = candidate.previousStatus === candidate.status
      && (!rule.flag.issues || candidate.previousIssues === properties[rule.flag.issues]);
    if (unchanged) { skipped.unchanged += 1; continue; }
    if (rule.flag.checkedAt) properties[rule.flag.checkedAt] = checkedAt;
    updates.push({ ruleKey: candidate.ruleKey, objectTypeId: candidate.objectTypeId, id: candidate.id, status: candidate.status, properties });
  }

  const cap = config.settings.maxFlagUpdatesPerRun;
  if (updates.length > cap) {
    skipped.deferredByCap = updates.length - cap;
    updates = updates.slice(0, cap);
  }
  return { writesAllowed, reason, updates, plannedCount: updates.length, skipped };
}
