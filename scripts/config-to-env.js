#!/usr/bin/env node
/**
 * Turns config.json into a single GUARD_CONFIG_JSON line for n8n (n8n Code nodes cannot read files).
 * The "environment" block is dropped, so tokens and webhook URLs never end up inside GUARD_CONFIG_JSON.
 *
 *   npm run config:env                  reads ./config.json
 *   npm run config:env -- other.json    reads another file
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadGuardConfig, validateGuardConfig } from '../src/core/config.js';

export function toEnvLine(document) {
  const { settings, associationTypes, rules } = document;
  const compact = { settings: settings || {}, associationTypes: associationTypes || {}, rules: rules || [] };
  return `GUARD_CONFIG_JSON=${JSON.stringify(compact)}`;
}

export function checkDocument(document) {
  const { settings, associationTypes, rules } = document;
  const config = loadGuardConfig({ HUBSPOT_PRIVATE_APP_TOKEN: 'validation-only' }, { guardDocument: { settings, associationTypes, rules } });
  return validateGuardConfig(config).errors.filter((error) => !error.startsWith('GUARD_CONFIG_JSON is missing'));
}

if (process.argv[1] && process.argv[1].endsWith('config-to-env.js')) {
  const path = resolve(process.cwd(), process.argv[2] || 'config.json');
  try {
    const document = JSON.parse(readFileSync(path, 'utf8'));
    const problems = checkDocument(document);
    if (problems.length) {
      console.error(`Warning: ${path} still has problems that will stop a HubSpot run:\n- ${problems.join('\n- ')}\n`);
    }
    console.log(toEnvLine(document));
  } catch (error) {
    console.error(`Could not read ${path}: ${error.message}`);
    process.exitCode = 1;
  }
}
