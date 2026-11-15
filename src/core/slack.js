/**
 * Slack Block Kit payloads for audit alerts and failure alerts.
 * Record names stay out of Slack unless SLACK_INCLUDE_RECORD_NAMES=true; IDs and links are enough to triage.
 */
import { describeViolation } from './integrity.js';
import { recordUrl } from './hubspot.js';

const SECTION_LIMIT = 2900;
const STATUS_ICON = { orphaned: ':red_circle:', conflict: ':large_orange_circle:', at_risk: ':large_yellow_circle:', unverified: ':white_circle:' };
const STATUS_TEXT = { orphaned: 'orphaned', conflict: 'conflict', at_risk: 'at risk', unverified: 'unverified' };

export function escapeSlack(text) {
  return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clip(text, limit = SECTION_LIMIT) {
  return text.length > limit ? `${text.slice(0, limit - 20)}\n_...list shortened_` : text;
}

function section(text) {
  return { type: 'section', text: { type: 'mrkdwn', text: clip(text) } };
}

function percent(rate) {
  return `${Math.round(rate * 1000) / 10}%`;
}

export function badgesFor(report) {
  const badges = [];
  if (report.mode === 'demo') badges.push('DEMO DATA');
  if (report.safety.dryRun) badges.push('DRY RUN');
  if (report.safety.sandboxMode) badges.push('SANDBOX');
  return badges;
}

export function issueCount(report) {
  return report.totals.orphaned + report.totals.conflict + report.totals.atRisk;
}

/** True when the run found something worth a message, or ALERT_ON_CLEAN_RUN=true. */
export function shouldAlert(report, config) {
  if (config.slack.alertOnCleanRun) return true;
  return issueCount(report) > 0
    || report.totals.unverified > 0
    || report.rules.some((rule) => rule.truncated || rule.circuitBreaker.tripped);
}

export function describeFlagOutcome(flagPlan, flagResults) {
  const skipped = flagPlan.skipped;
  const extras = [];
  if (skipped.unchanged) extras.push(`${skipped.unchanged} already flagged`);
  if (skipped.circuitBreaker) extras.push(`${skipped.circuitBreaker} held by the circuit breaker`);
  if (skipped.deferredByCap) extras.push(`${skipped.deferredByCap} deferred by MAX_FLAG_UPDATES_PER_RUN`);
  if (skipped.unverified) extras.push(`${skipped.unverified} unverified`);
  const tail = extras.length ? ` (${extras.join(', ')})` : '';
  if (!flagPlan.writesAllowed) return `${flagPlan.plannedCount} flag update(s) planned, none written: ${flagPlan.reason}${tail}.`;
  if (!flagResults || !flagResults.executed) return `No flag updates were needed${tail}.`;
  const failed = flagResults.failed ? `, ${flagResults.failed} failed` : '';
  return `${flagResults.updated} of ${flagResults.attempted} flag update(s) written${failed}${tail}.`;
}

export function summarizeReport(report) {
  return {
    runId: report.runId,
    generatedAt: report.generatedAt,
    mode: report.mode,
    safety: report.safety,
    totals: report.totals,
    rules: report.rules.map((rule) => ({
      key: rule.key,
      scanned: rule.scanned,
      evaluated: rule.evaluated,
      orphaned: rule.orphaned,
      conflict: rule.conflict,
      atRisk: rule.atRisk,
      unverified: rule.unverified,
      truncated: rule.truncated,
      circuitBreakerTripped: rule.circuitBreaker.tripped,
    })),
  };
}

export function buildSlackAlert({ report, flagPlan, flagResults, config }) {
  const totals = report.totals;
  const issues = issueCount(report);
  const badges = badgesFor(report);
  const badgeText = badges.length ? `[${badges.join(' | ')}] ` : '';
  const headline = issues === 0
    ? 'No association integrity issues found'
    : `${totals.orphaned} orphaned, ${totals.conflict} conflicting, ${totals.atRisk} at risk`;
  const text = `${badgeText}Association Integrity Guard: ${headline} across ${report.rules.length} object type(s).`;

  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Association Integrity Guard', emoji: true } },
    section([
      `${badges.length ? `*${badges.join('  ·  ')}*\n` : ''}*${headline}*`,
      `${totals.evaluated} evaluated · ${totals.skippedGrace} in the ${report.settings.gracePeriodHours}h grace period · ${totals.skippedExcluded} excluded by rule filters${totals.unverified ? ` · ${totals.unverified} could not be verified` : ''}`,
    ].join('\n')),
  ];

  const ruleLines = report.rules.map((rule) => {
    let line = `• *${escapeSlack(rule.label)}* (\`${escapeSlack(rule.objectTypeId)}\`): ${rule.scanned} scanned, ${rule.orphaned} orphaned, ${rule.conflict} conflicting, ${rule.atRisk} at risk, orphan rate ${percent(rule.orphanRate)}`;
    if (rule.truncated) line += '\n   :warning: Record limit reached, so this object was only partly audited.';
    if (rule.circuitBreaker.tripped) line += `\n   :rotating_light: Circuit breaker: ${escapeSlack(rule.circuitBreaker.reason)}`;
    return line;
  });
  blocks.push(section(`*By object*\n${ruleLines.join('\n')}`));

  const samples = report.findings.slice(0, config.slack.maxSamples);
  if (samples.length) {
    const lines = samples.map((finding) => {
      const name = config.slack.includeRecordNames && finding.display ? ` ${escapeSlack(finding.display)}` : '';
      const reference = `${escapeSlack(finding.ruleLabel)} ${escapeSlack(finding.id)}${name}`;
      const url = recordUrl(report.account, finding.objectTypeId, finding.id);
      const link = url ? `<${url}|${reference}>` : reference;
      const detail = finding.status === 'unverified'
        ? 'HubSpot returned an error for this record, so it was not judged'
        : finding.violations.map((violation) => escapeSlack(describeViolation(violation))).join('; ');
      return `${STATUS_ICON[finding.status] || ''} ${link} (${STATUS_TEXT[finding.status] || finding.status}): ${detail}`;
    });
    const more = report.findings.length > samples.length ? `\n_${report.findings.length - samples.length} more not shown._` : '';
    blocks.push(section(`*Top findings*\n${lines.join('\n')}${more}`));
  }

  blocks.push(section(`*Flags*\n${escapeSlack(describeFlagOutcome(flagPlan, flagResults))}`));
  if (report.cleared.length) blocks.push(section(`:white_check_mark: ${report.cleared.length} previously flagged record(s) are healthy again.`));
  blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Run ${escapeSlack(report.runId)} · ${escapeSlack(report.generatedAt)}` }] });
  return { text, blocks };
}

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /pat-[a-z0-9]+-[A-Za-z0-9-]+/gi,
  /https:\/\/hooks\.slack\.com\/[^\s"']+/gi,
];
const QUERY_SECRET_PATTERN = /([?&](?:hapikey|api_key|token)=)[^&\s"']+/gi;

export function redactSecrets(text) {
  let output = String(text ?? '');
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, '[redacted]');
  return output.replace(QUERY_SECRET_PATTERN, '$1[redacted]');
}

export function buildFailureAlert({ errorMessage, lastNode, executionId, workflowName, mode }) {
  const message = redactSecrets(errorMessage || 'Unknown error').slice(0, 1500);
  const where = lastNode ? ` in node "${escapeSlack(lastNode)}"` : '';
  const text = `Association Integrity Guard failed${lastNode ? ` in "${lastNode}"` : ''}. Check the n8n execution log.`;
  return {
    text,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Association Integrity Guard failed', emoji: true } },
      section(`:x: The audit stopped${where}.\n\`\`\`${escapeSlack(message)}\`\`\``),
      section('Read stages fail closed: if the failure happened while reading HubSpot, the run stopped before any flag was written. Flag writes are idempotent, so after fixing the cause it is safe to re-run the workflow manually.'),
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Workflow ${escapeSlack(workflowName || 'n8n-hubspot-custom-object-association-integrity-guard')} · execution ${escapeSlack(executionId || 'unknown')} · ${escapeSlack(mode || 'unknown')} mode` }] },
    ],
  };
}
