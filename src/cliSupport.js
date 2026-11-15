/**
 * Shared helpers for the command-line entry points: .env loading, config.json loading and
 * an HTTP function that respects demo mode.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadGuardConfig, isPlaceholder } from './core/config.js';
import { loadDemoConfig, createDemoState } from './core/demoData.js';
import { createMockHubSpot } from './core/mockHubSpot.js';
import { createHubSpotHttp } from './core/pipeline.js';

/** Minimal .env parser (KEY=value, optional quotes, # comments). Existing variables win. */
export function parseDotEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    values[match[1]] = value;
  }
  return values;
}

export function readGuardFile(path) {
  const document = JSON.parse(readFileSync(path, 'utf8'));
  const { environment = {}, settings, associationTypes, rules } = document;
  return { environment, guardDocument: { settings, associationTypes, rules } };
}

/**
 * Precedence for each variable: the shell environment, then .env, then the "environment" block of
 * the config file. Rules come from --config, then GUARD_CONFIG_JSON, then ./config.json.
 */
export function loadCliContext(argv = process.argv.slice(2), { cwd = process.cwd(), baseEnv = process.env } = {}) {
  const args = { demo: argv.includes('--demo'), json: argv.includes('--json'), failOnFindings: argv.includes('--fail-on-findings'), help: argv.includes('--help') || argv.includes('-h') };
  const configIndex = argv.indexOf('--config');
  const explicitConfig = configIndex >= 0 ? argv[configIndex + 1] : null;
  if (configIndex >= 0 && !explicitConfig) throw new Error('--config needs a file path');

  const dotEnvPath = resolve(cwd, '.env');
  const dotEnv = existsSync(dotEnvPath) ? parseDotEnv(readFileSync(dotEnvPath, 'utf8')) : {};
  let configPath = explicitConfig ? resolve(cwd, explicitConfig) : null;
  const shellAndDotEnv = { ...dotEnv, ...baseEnv };
  if (!configPath && isPlaceholder(shellAndDotEnv.GUARD_CONFIG_JSON) && existsSync(resolve(cwd, 'config.json'))) configPath = resolve(cwd, 'config.json');

  let fileEnvironment = {};
  let guardDocument;
  let source = 'GUARD_CONFIG_JSON';
  if (configPath) {
    const file = readGuardFile(configPath);
    fileEnvironment = file.environment;
    guardDocument = file.guardDocument;
    source = configPath;
  }
  const env = { ...fileEnvironment, ...shellAndDotEnv };
  // Demo mode (forced, or because the token is a placeholder) always uses the bundled demo rules.
  let config = loadGuardConfig(env, guardDocument ? { guardDocument } : {});
  if (args.demo || config.mode === 'demo') config = loadDemoConfig(env);
  return { args, env, config, source: config.mode === 'demo' ? 'bundled demo dataset' : source };
}

/** Real HubSpot in hubspot mode, the in-memory mock in demo mode. */
export function createCliHttp(config, log) {
  if (config.mode === 'demo') return createMockHubSpot(createDemoState()).request;
  return createHubSpotHttp({ token: config.hubspot.token, log });
}
