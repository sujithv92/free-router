#!/usr/bin/env node

import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createProviderRegistry,
  isChatModel,
  isZeroCost,
  normalizeModelSlug,
  supportsRequest,
} from './providers.mjs';
import { installUpstreamProxy } from './proxy.mjs';
import { msUntilQuotaReset, parseQuotaFailure, permanentRejection } from './quota.mjs';
import { createSecretRedactor } from './redact.mjs';
import {
  createStreamSignatureExtractor,
  createThoughtSignatureCache,
  injectThoughtSignatures,
  isMissingThoughtSignatureError,
  providerNeedsThoughtSignatures,
  rememberSignaturesFromPayload,
} from './thought-signature.mjs';
import { displayPath, maskSecret, renderPage, updateEnvFile, validateSecret } from './ui.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version;

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!value || process.env[match[1]]) continue;
    process.env[match[1]] = value;
  }
}

const envCandidates = [
  path.join(HERE, '.env'),
  path.join(os.homedir(), '.hermes', '.env'),
];
for (const file of envCandidates) {
  if (file) loadEnvFile(file);
}

const CONFIG_PATH = process.env.FREE_ROUTER_CONFIG || path.join(HERE, 'config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
installUpstreamProxy(
  (message) => {
    console.log(`[${new Date().toISOString()}]`, message);
  },
  { socksFirstHosts: config.socksFirstHosts || [] },
);
const HOST = process.env.FREE_ROUTER_HOST || config.host || '127.0.0.1';
// Container platforms assign the port and inject it as PORT. SnapDeploy sets
// and locks it, so honouring PORT is what makes a zero-config image reachable;
// FREE_ROUTER_PORT stays the explicit override for anyone who wants one.
const PORT = Number(process.env.FREE_ROUTER_PORT || process.env.PORT || config.port || 8787);
// /v1 and /health have no caller identity of their own, so a container bound
// to 0.0.0.0 hands anyone who can reach the port your upstream quota. Setting
// a shared secret makes them require it, and unlocks the web interface off
// loopback so a deployed instance is still manageable. Leaving it unset keeps
// the original loopback-only behaviour for local runs.
const API_TOKEN = String(process.env.FREE_ROUTER_API_KEY || '');
const ATTEMPT_TIMEOUT_MS = Number(
  process.env.FREE_ROUTER_ATTEMPT_TIMEOUT_MS || config.attemptTimeoutMs || 180000,
);
const CATALOG_REFRESH_MS = Number(config.catalogRefreshMs || 900000);
const registry = createProviderRegistry(config, { host: HOST, port: PORT });
const PROVIDERS = registry.providers;
const discoveryConfig = config.discovery || {};
const DISCOVERY_ENABLED = discoveryConfig.enabled !== false;
const DISCOVERY_INTERVAL_MS = Number(discoveryConfig.intervalMs || 7 * 24 * 60 * 60 * 1000);
const DISCOVERY_ROUTE = String(discoveryConfig.route || 'free-best');
// How long a "not free" verdict stands before the model is worth asking again.
const VERDICT_RETRY_MS = Number(discoveryConfig.verdictRetryMs || DISCOVERY_INTERVAL_MS);
const DISCOVERY_STATE_PATH = path.resolve(
  path.dirname(CONFIG_PATH),
  discoveryConfig.stateFile || 'discovered-free-models.json',
);
function compilePatterns(patterns, label) {
  const compiled = [];
  for (const pattern of patterns || []) {
    try {
      compiled.push(new RegExp(String(pattern), 'i'));
    } catch (error) {
      log(`ignoring invalid ${label} pattern ${pattern}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return compiled;
}

const excludeConfig = discoveryConfig.exclude || {};
const EXCLUDE_MODEL_PATTERNS = compilePatterns(excludeConfig.modelPatterns, 'exclude.modelPatterns');
const EXCLUDE_TEXT_PATTERNS = compilePatterns(excludeConfig.textPatterns, 'exclude.textPatterns');
const evaluationConfig = discoveryConfig.evaluation || {};
const EVALUATION_ENABLED = evaluationConfig.enabled !== false;
const EVALUATION_MAX_TOKENS = Number(evaluationConfig.maxTokens || 4000);
// Bumped whenever the benchmark or its weights change, so stored scores from an
// older scale get recomputed instead of being compared against new ones.
const EVALUATION_VERSION = 2;
const EVALUATION_MAX_PER_RUN = Math.max(1, Number(evaluationConfig.maxPerRun || 8));
const RANK_USAGE_WEIGHT = Math.max(0, Number(evaluationConfig.usageWeight ?? 12));
const RANK_USAGE_MIN_REQUESTS = Math.max(1, Number(evaluationConfig.usageMinRequests || 20));
const PINNED_MODELS = new Set(evaluationConfig.pinnedModels || []);
const usageConfig = config.usage || {};
const USAGE_RETENTION_DAYS = Math.max(1, Number(usageConfig.retentionDays || 7));
const USAGE_TIMEZONE = String(usageConfig.timezone || '');
const USAGE_DAILY_LIMITS = usageConfig.dailyLimits || {};
const USAGE_KINDS = [
  'ok',
  'rateLimit',
  'timeout',
  'serverError',
  'empty',
  'notFound',
  'forbidden',
  'aborted',
  'other',
];
// A rejected request never reaches the model, so it does not burn daily quota.
const USAGE_NON_CONSUMING = new Set(['rateLimit', 'notFound', 'forbidden']);
const USAGE_DAY_FORMATTER = (() => {
  if (!USAGE_TIMEZONE) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: USAGE_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    log(`invalid usage.timezone ${USAGE_TIMEZONE}; falling back to local dates`);
    return null;
  }
})();
const uiConfig = config.ui || {};
const UI_ENABLED = uiConfig.enabled !== false;
const UI_ENV_PATH = path.resolve(path.dirname(CONFIG_PATH), uiConfig.envFile || '.env');
let secretRedactor = config.redactSecrets === false ? null : createSecretRedactor();

// The redactor snapshots process.env at build time, so a key added through the
// UI would otherwise never be stripped from upstream payloads.
function refreshSecretRedactor() {
  if (config.redactSecrets === false) return;
  secretRedactor = createSecretRedactor();
}

const cooldowns = new Map();
const thoughtSignatures = createThoughtSignatureCache();
let discoveredModelIds = [];
let discoverySeenIds = [];
let discoveryRemovedIds = [];
let discoveryLastCheckedAt = 0;
let discoveryError = '';
let discoveryInFlight = null;
let modelEvaluations = {};
let discoveryExcludedIds = [];
let discoveryUnavailableIds = [];
// What providers told us about their own free tier, keyed by `provider:model`.
let modelVerdicts = {};
let lastSelection = null;
let usageByDay = {};
let stateSaveTimer = null;

function log(message, detail = undefined) {
  const prefix = `[${new Date().toISOString()}]`;
  if (detail === undefined) console.log(prefix, message);
  else console.log(prefix, message, detail);
}

function normalizeCandidate(entry) {
  if (typeof entry === 'string') return { provider: registry.defaultProvider, model: entry };
  if (entry && typeof entry === 'object') {
    return {
      provider: String(entry.provider || registry.defaultProvider),
      model: String(entry.model || entry.id || ''),
    };
  }
  return { provider: registry.defaultProvider, model: '' };
}

function candidateKey(candidate) {
  return `${candidate.provider}:${candidate.model}`;
}

function keySlug(key) {
  const separator = String(key).indexOf(':');
  return normalizeModelSlug(separator >= 0 ? key.slice(separator + 1) : key);
}

function candidateMetadata(candidate) {
  return registry.metadata(candidate);
}

// A negative verdict is worth acting on but not worth trusting forever: a
// provider blip would otherwise retire a model permanently with no way back.
// Positive verdicts need no expiry, since ordinary traffic revisits them and a
// later refusal overwrites them.
function verdictFor(key) {
  const verdict = modelVerdicts[key];
  if (!verdict) return null;
  if (verdict.free !== false) return verdict;
  const age = Date.now() - Date.parse(verdict.observedAt || 0);
  return Number.isFinite(age) && age > VERDICT_RETRY_MS ? null : verdict;
}

// What the provider itself told us outranks any local allowlist, in both
// directions: a list in config.json is only ever a guess about someone else's
// pricing, while a served request or a quota figure is a direct answer.
function candidateIsFree(candidate) {
  const verdict = verdictFor(candidateKey(candidate));
  if (verdict?.free === false) return false;
  if (verdict?.free === true) return Boolean(PROVIDERS.get(candidate.provider)?.apiKey);
  return registry.isFree(candidate);
}

function setModelVerdict(key, verdict) {
  const previous = modelVerdicts[key];
  const merged = {
    ...previous,
    ...verdict,
    observedAt: new Date().toISOString(),
  };
  if (previous?.free === merged.free && previous?.dailyRequestLimit === merged.dailyRequestLimit) {
    return;
  }
  modelVerdicts[key] = merged;
  scheduleStateSave();
}

// Models named in config.json, either in a route or a provider allowlist.
function configuredCandidateKeys() {
  const keys = new Set();
  for (const entries of Object.values(config.routes || {})) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) keys.add(candidateKey(normalizeCandidate(entry)));
  }
  for (const provider of PROVIDERS.values()) {
    for (const model of provider.freeModels) keys.add(`${provider.name}:${model}`);
  }
  return keys;
}

// Only the verdicts that contradict something asked for. A probe finding that
// some catalog model has no free tier is discovery working, not news: reporting
// every one of those buries the single case that needs attention, a model
// written into config.json that the provider will not serve for free.
function rejectedConfiguredModels() {
  const configured = configuredCandidateKeys();
  return Object.keys(modelVerdicts)
    .filter((key) => configured.has(key) && verdictFor(key)?.free === false)
    .sort()
    .map((key) => ({ key, reason: modelVerdicts[key].reason || '' }));
}

// The provider's own number beats the hand-written one in config.json.
function learnedDailyLimit(key) {
  const learned = Number(modelVerdicts[key]?.dailyRequestLimit);
  return Number.isFinite(learned) && learned > 0 ? learned : null;
}

function discoveredCandidate(id) {
  return registry.parsePrefixed(id) || { provider: registry.discoveryProvider, model: id };
}

// Narrow, domain-tuned models score well on a generic benchmark but are a poor
// default for general traffic. Returns a reason string, or '' to keep the model.
// Only applies to auto-discovered models; anything listed in config.json stays.
function discoveryExclusionReason(id) {
  for (const pattern of EXCLUDE_MODEL_PATTERNS) {
    if (pattern.test(id)) return `model id matches /${pattern.source}/`;
  }
  if (!EXCLUDE_TEXT_PATTERNS.length) return '';
  const model = candidateMetadata(discoveredCandidate(id));
  if (!model) return '';
  const text = `${model.name || ''} ${model.description || ''}`;
  for (const pattern of EXCLUDE_TEXT_PATTERNS) {
    if (pattern.test(text)) return `description matches /${pattern.source}/`;
  }
  return '';
}

// Combines what the last discovery run filtered out with anything currently
// tracked that the filter now rejects, so a pattern added between runs is
// visible immediately instead of only after the next collection.
function excludedModelIds() {
  const ids = new Set(discoveryExcludedIds);
  for (const id of discoveredModelIds) {
    if (discoveryExclusionReason(id)) ids.add(id);
  }
  return [...ids].sort();
}

function usageDay(at = Date.now()) {
  const date = new Date(at);
  if (USAGE_DAY_FORMATTER) return USAGE_DAY_FORMATTER.format(date);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function usageDays() {
  const days = [];
  for (let offset = 0; offset < USAGE_RETENTION_DAYS; offset += 1) {
    days.push(usageDay(Date.now() - offset * 86400000));
  }
  return days;
}

function sanitizeUsage(raw) {
  const clean = {};
  if (!raw || typeof raw !== 'object') return clean;
  for (const [day, models] of Object.entries(raw)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !models || typeof models !== 'object') continue;
    const perModel = {};
    for (const [key, counts] of Object.entries(models)) {
      if (!counts || typeof counts !== 'object') continue;
      const bucket = {};
      for (const kind of USAGE_KINDS) {
        const value = Math.floor(Number(counts[kind]));
        if (Number.isFinite(value) && value > 0) bucket[kind] = value;
      }
      if (Object.keys(bucket).length) perModel[key] = bucket;
    }
    if (Object.keys(perModel).length) clean[day] = perModel;
  }
  return clean;
}

function pruneUsage() {
  const keep = new Set(usageDays());
  for (const day of Object.keys(usageByDay)) {
    if (!keep.has(day)) delete usageByDay[day];
  }
}

function recordUsage(candidate, kind) {
  const bucket = USAGE_KINDS.includes(kind) ? kind : 'other';
  const day = usageDay();
  const perDay = (usageByDay[day] ||= {});
  const counts = (perDay[candidateKey(candidate)] ||= {});
  counts[bucket] = (counts[bucket] || 0) + 1;
  pruneUsage();
  scheduleStateSave();
}

function dailyLimitFor(key) {
  // A limit the provider reported for itself is authoritative; the config
  // value is only a stand-in until the provider tells us the real one.
  const learned = learnedDailyLimit(key);
  if (learned) return learned;
  const separator = String(key).indexOf(':');
  const provider = separator >= 0 ? key.slice(0, separator) : '';
  const model = separator >= 0 ? key.slice(separator + 1) : key;
  for (const lookup of [key, model, `${provider}:*`]) {
    const value = Number(USAGE_DAILY_LIMITS[lookup]);
    if (Number.isFinite(value) && value > 0) return value;
  }
  return null;
}

function dailyLimitSource(key) {
  if (learnedDailyLimit(key)) return 'provider';
  return dailyLimitFor(key) ? 'config' : '';
}

function usageTotals(counts) {
  let ok = 0;
  let fail = 0;
  let aborted = 0;
  let consumed = 0;
  for (const [kind, raw] of Object.entries(counts || {})) {
    const amount = Number(raw) || 0;
    if (amount <= 0) continue;
    if (kind === 'ok') ok += amount;
    else if (kind === 'aborted') aborted += amount;
    else fail += amount;
    if (!USAGE_NON_CONSUMING.has(kind)) consumed += amount;
  }
  return { ok, fail, aborted, consumed, total: ok + fail + aborted };
}

function mergeUsage(target, counts) {
  for (const [kind, raw] of Object.entries(counts || {})) {
    const amount = Number(raw) || 0;
    if (amount > 0) target[kind] = (target[kind] || 0) + amount;
  }
  return target;
}

function usageForKey(key) {
  const days = usageDays();
  const todayCounts = usageByDay[days[0]]?.[key] || {};
  const windowCounts = {};
  for (const day of days) mergeUsage(windowCounts, usageByDay[day]?.[key]);
  const limit = dailyLimitFor(key);
  const today = usageTotals(todayCounts);
  return {
    today,
    window: usageTotals(windowCounts),
    dailyLimit: limit,
    dailyLimitSource: dailyLimitSource(key),
    remainingToday: limit === null ? null : Math.max(0, limit - today.consumed),
  };
}

function usageSummary() {
  const days = usageDays();
  const byModel = {};
  const byDay = days.map((day) => {
    const dayCounts = {};
    let topModel = null;
    for (const [key, counts] of Object.entries(usageByDay[day] || {})) {
      mergeUsage(dayCounts, counts);
      mergeUsage((byModel[key] ||= {}), counts);
      const totals = usageTotals(counts);
      if (!topModel || totals.ok > topModel.ok) topModel = { key, ok: totals.ok };
    }
    return { day, ...usageTotals(dayCounts), counts: dayCounts, topModel };
  });
  const models = Object.entries(byModel)
    .map(([key, counts]) => {
      const separator = key.indexOf(':');
      const limit = dailyLimitFor(key);
      const today = usageTotals(usageByDay[days[0]]?.[key] || {});
      return {
        key,
        provider: separator >= 0 ? key.slice(0, separator) : '',
        model: separator >= 0 ? key.slice(separator + 1) : key,
        ...usageTotals(counts),
        counts,
        dailyLimit: limit,
        dailyLimitSource: dailyLimitSource(key),
        today,
        remainingToday: limit === null ? null : Math.max(0, limit - today.consumed),
      };
    })
    .sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
  return {
    timezone: USAGE_TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
    retentionDays: USAGE_RETENTION_DAYS,
    today: days[0],
    days: byDay,
    models,
  };
}

function loadDiscoveryState() {
  if (!fs.existsSync(DISCOVERY_STATE_PATH)) return;
  try {
    const state = JSON.parse(fs.readFileSync(DISCOVERY_STATE_PATH, 'utf8'));
    usageByDay = sanitizeUsage(state.usage);
    pruneUsage();
    if (!DISCOVERY_ENABLED) return;
    discoveredModelIds = Array.isArray(state.addedModels)
      ? state.addedModels.filter((id) => typeof id === 'string')
      : [];
    discoverySeenIds = Array.isArray(state.freeModels)
      ? state.freeModels.filter((id) => typeof id === 'string')
      : [];
    discoveryRemovedIds = Array.isArray(state.removedModels)
      ? state.removedModels.filter((id) => typeof id === 'string')
      : [];
    discoveryExcludedIds = Array.isArray(state.excludedModels)
      ? state.excludedModels.filter((id) => typeof id === 'string')
      : [];
    discoveryUnavailableIds = Array.isArray(state.unavailableModels)
      ? state.unavailableModels.filter((id) => typeof id === 'string')
      : [];
    modelVerdicts =
      state.modelVerdicts && typeof state.modelVerdicts === 'object' ? state.modelVerdicts : {};
    discoveryLastCheckedAt = Date.parse(state.lastCheckedAt || '') || 0;
    modelEvaluations =
      state.evaluations && typeof state.evaluations === 'object' ? state.evaluations : {};
    if (state.lastSelection && typeof state.lastSelection === 'object') {
      lastSelection = state.lastSelection;
    }
  } catch (error) {
    discoveryError = `state load failed: ${error instanceof Error ? error.message : String(error)}`;
    log(discoveryError);
  }
}

function saveDiscoveryState() {
  const payload = {
    lastCheckedAt: new Date(discoveryLastCheckedAt).toISOString(),
    route: DISCOVERY_ROUTE,
    freeModels: discoverySeenIds,
    addedModels: discoveredModelIds,
    removedModels: discoveryRemovedIds,
    excludedModels: discoveryExcludedIds,
    unavailableModels: discoveryUnavailableIds,
    modelVerdicts,
    evaluations: modelEvaluations,
    lastSelection,
    usage: usageByDay,
  };
  const temporaryPath = `${DISCOVERY_STATE_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(temporaryPath, DISCOVERY_STATE_PATH);
}

function flushStateSave() {
  if (stateSaveTimer) {
    clearTimeout(stateSaveTimer);
    stateSaveTimer = null;
  }
  try {
    saveDiscoveryState();
  } catch (error) {
    log(`failed to persist router state: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Every request touches the counters, so batch writes instead of rewriting the
// state file once per attempt.
function scheduleStateSave(delayMs = 1500) {
  if (stateSaveTimer) return;
  stateSaveTimer = setTimeout(() => {
    stateSaveTimer = null;
    flushStateSave();
  }, delayMs);
  stateSaveTimer.unref?.();
}

function rememberSelection(selection) {
  lastSelection = selection;
  scheduleStateSave();
}

// A manual override in `baselineScores`, keyed by `provider:model` or by the
// bare model ID. Applies to discovered models too, not just configured ones.
function explicitScore(key) {
  const modelId = String(key).includes(':') ? key.slice(key.indexOf(':') + 1) : key;
  const explicit = Number(
    evaluationConfig.baselineScores?.[key] ?? evaluationConfig.baselineScores?.[modelId],
  );
  return Number.isFinite(explicit) ? explicit : null;
}

function configuredScore(id, configuredIndex) {
  const explicit = explicitScore(id);
  if (explicit !== null) return explicit;
  return Math.max(30, 94 - Math.max(0, configuredIndex - 1) * 4);
}

// Observed reliability nudges a model up or down once it has served enough
// traffic to be more trustworthy than a single one-shot evaluation.
function usageAdjustment(key) {
  if (!RANK_USAGE_WEIGHT) return 0;
  const counts = {};
  for (const day of usageDays()) mergeUsage(counts, usageByDay[day]?.[key]);
  const totals = usageTotals(counts);
  const attempts = totals.ok + totals.fail;
  if (attempts < RANK_USAGE_MIN_REQUESTS) return 0;
  const successRate = totals.ok / attempts;
  const scaled = ((successRate - 0.8) / 0.2) * RANK_USAGE_WEIGHT;
  const clamped = Math.max(-RANK_USAGE_WEIGHT, Math.min(RANK_USAGE_WEIGHT, scaled));
  return Math.round(clamped * 10) / 10;
}

function baseModelScore(key, configured, configuredIndex) {
  const slug = keySlug(key);
  const modelId = key.includes(':') ? key.slice(key.indexOf(':') + 1) : key;
  if (PINNED_MODELS.has(key) || PINNED_MODELS.has(modelId)) return Number.POSITIVE_INFINITY;
  if (configured.has(key)) return configuredScore(key, configuredIndex.get(key));
  for (const [configuredKey, index] of configuredIndex) {
    if (keySlug(configuredKey) === slug) return configuredScore(configuredKey, index);
  }
  const explicit = explicitScore(key);
  if (explicit !== null) return explicit;
  const evaluated = Number(modelEvaluations[modelId]?.score);
  return Number.isFinite(evaluated) ? evaluated : -1;
}

function rankedModelScore(key, configured, configuredIndex) {
  const base = baseModelScore(key, configured, configuredIndex);
  if (!Number.isFinite(base) || base < 0) return base;
  return Math.round((base + usageAdjustment(key)) * 10) / 10;
}

function scoreSourceFor(key, configured) {
  if (configured.has(key)) return 'baseline';
  const slug = keySlug(key);
  for (const configuredKey of configured) {
    if (keySlug(configuredKey) === slug) return 'baseline';
  }
  return 'evaluation';
}

function groupRank(group, configuredSet, configuredIndex) {
  let pinned = false;
  let pinIndex = Number.POSITIVE_INFINITY;
  let configuredIdx = Number.POSITIVE_INFINITY;
  let configuredKey = '';
  let evalScore = -1;
  let explicit = null;
  for (const { candidate, originalIndex } of group.members) {
    const key = candidateKey(candidate);
    if (PINNED_MODELS.has(key) || PINNED_MODELS.has(candidate.model)) {
      pinned = true;
      pinIndex = Math.min(pinIndex, originalIndex);
    }
    if (configuredSet.has(key) && configuredIndex.get(key) < configuredIdx) {
      configuredIdx = configuredIndex.get(key);
      configuredKey = key;
    }
    const override = explicitScore(key);
    if (override !== null && (explicit === null || override > explicit)) explicit = override;
    const evaluated = Number(modelEvaluations[candidate.model]?.score);
    if (Number.isFinite(evaluated)) evalScore = Math.max(evalScore, evaluated);
  }
  for (const [key, index] of configuredIndex) {
    if (keySlug(key) !== group.slug || index >= configuredIdx) continue;
    configuredIdx = index;
    configuredKey = key;
  }
  const base = pinned
    ? Number.POSITIVE_INFINITY
    : configuredIdx !== Number.POSITIVE_INFINITY
      ? configuredScore(configuredKey, configuredIdx)
      : explicit !== null
        ? explicit
        : evalScore;
  let score = base;
  if (!pinned && Number.isFinite(base) && base >= 0) {
    const adjustments = group.members.map(({ candidate }) =>
      usageAdjustment(candidateKey(candidate)),
    );
    score = base + (adjustments.length ? Math.max(...adjustments) : 0);
  }
  return { pinned, score, tie: pinned ? pinIndex : group.firstIndex };
}

function orderByModelThenProvider(candidates, configuredSet, configuredIndex) {
  // Rank each route entry on its own: group by `provider:model` so an
  // unpinned variant of a model does not inherit the pinned status or score
  // of a differently-cased or differently-provider variant.
  const groups = new Map();
  candidates.forEach((candidate, originalIndex) => {
    const key = candidateKey(candidate);
    let group = groups.get(key);
    if (!group) {
      group = { slug: normalizeModelSlug(candidate.model) || key, members: [], firstIndex: originalIndex };
      groups.set(key, group);
    }
    group.members.push({ candidate, originalIndex });
  });
  const ranked = [...groups.values()].sort((left, right) => {
    const a = groupRank(left, configuredSet, configuredIndex);
    const b = groupRank(right, configuredSet, configuredIndex);
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    if (a.pinned) return a.tie - b.tie;
    return b.score - a.score || a.tie - b.tie;
  });
  const expanded = [];
  const present = new Set();
  const expandedSlugs = new Set();
  // Variants that are already candidates rank on their own group, so the
  // expansion only adds genuinely new same-model offerings.
  const candidateKeys = new Set(candidates.map(candidateKey));
  const emit = (candidate) => {
    const key = candidateKey(candidate);
    if (present.has(key)) return;
    present.add(key);
    expanded.push(candidate);
  };
  for (const group of ranked) {
    for (const { candidate } of group.members.sort((a, b) => a.originalIndex - b.originalIndex)) {
      emit(candidate);
    }
    // Same-model offerings from other providers are offered once per model
    // slug, at the position of the highest-ranked variant of that model.
    if (expandedSlugs.has(group.slug)) continue;
    expandedSlugs.add(group.slug);
    for (const offering of registry.offeringsForSlug(group.slug)) {
      if (candidateKeys.has(candidateKey(offering))) continue;
      emit(offering);
    }
  }
  return expanded;
}

function routeCandidates(routeName) {
  const configured = config.routes?.[routeName];
  if (!configured) return null;
  const normalizedConfigured = configured.map(normalizeCandidate).filter((candidate) => candidate.model);
  const activeConfigured = normalizedConfigured.filter(candidateIsFree);
  const configuredKeys = normalizedConfigured.map(candidateKey);
  const configuredSet = new Set(configuredKeys);
  const configuredIndex = new Map(configuredKeys.map((key, index) => [key, index]));
  if (!DISCOVERY_ENABLED || routeName !== DISCOVERY_ROUTE) {
    return orderByModelThenProvider(activeConfigured, configuredSet, configuredIndex);
  }

  const candidates = [...activeConfigured];
  const present = new Set(candidates.map(candidateKey));
  for (const id of discoveredModelIds) {
    if (discoveryExclusionReason(id)) continue;
    const candidate = discoveredCandidate(id);
    if (verdictFor(candidateKey(candidate))?.free === false) continue;
    if (present.has(candidateKey(candidate))) continue;
    const model = candidateMetadata(candidate);
    const provider = PROVIDERS.get(candidate.provider);
    if (provider?.catalogHasPricing && provider.catalog.size && (!model || !isZeroCost(model))) {
      continue;
    }
    candidates.push(candidate);
    present.add(candidateKey(candidate));
  }
  return orderByModelThenProvider(candidates, configuredSet, configuredIndex);
}

// Providers without published prices cannot offer new models safely, but their
// catalog still says what they stopped offering. Recomputed on every catalog
// refresh rather than once per discovery run, because routing already drops a
// missing model as soon as the catalog updates; recording it only every
// `discovery.intervalMs` would leave the log two days behind the behaviour.
function syncModelAvailability() {
  const current = registry.unavailableFreeModels();
  const gone = current.filter((id) => !discoveryUnavailableIds.includes(id));
  const restored = discoveryUnavailableIds.filter((id) => !current.includes(id));
  if (!gone.length && !restored.length) return;
  discoveryUnavailableIds = current;
  if (gone.length) log(`no longer offered upstream; skipped in routes`, gone);
  if (restored.length) log(`offered upstream again; restored to routes`, restored);
  scheduleStateSave();
}

async function refreshCatalog(force = false) {
  await registry.refreshCatalogs(force, CATALOG_REFRESH_MS, log);
  syncModelAvailability();
}

function evaluationText(payload) {
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (typeof part === 'string' ? part : part?.text || ''))
    .join('');
}

function parseEvaluationAnswers(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function metadataScore(model) {
  const supported = new Set(model?.supported_parameters || []);
  const contextLength = Number(model?.context_length || 0);
  const createdMs = Number(model?.created || 0) * 1000;
  let score = 0;
  if (supported.has('tools')) score += 6;
  if (supported.has('response_format') || supported.has('structured_outputs')) score += 4;
  score += Math.min(6, Math.max(0, Math.log2(Math.max(4096, contextLength) / 4096)));
  if ((model?.architecture?.input_modalities || ['text']).includes('text')) score += 2;
  if (createdMs && Date.now() - createdMs <= 180 * 24 * 60 * 60 * 1000) score += 2;
  return Math.round(score * 10) / 10;
}

async function evaluateModel(target) {
  const startedAt = Date.now();
  const candidate =
    typeof target === 'string'
      ? { provider: registry.discoveryProvider, model: target }
      : target;
  const model = candidateMetadata(candidate);
  const supported = new Set(model?.supported_parameters || []);
  const evaluationBody = {
    messages: [
      {
        role: 'user',
        content:
          'Return ONLY one JSON object with keys token, crt, trace, path, sequence, binary, ' +
          'derange, recur, modpow. ' +
          'No markdown and no explanation. token must be "OX-RANK-7". ' +
          'crt: smallest positive integer n where n%7=3, n%11=5, n%13=9. ' +
          'trace: output of JavaScript: let a=[1,2,3,4]; for(let i=0;i<a.length;i++){if(a[i]%2===0)a.splice(i,1)} console.log(a.join("-")). ' +
          'path: shortest distance A to E for undirected edges A-B:4,A-C:2,C-B:1,B-D:5,C-D:8,C-E:10,D-E:2. ' +
          'sequence: next number after 2,6,12,20,30. ' +
          'binary: number of binary strings of length 8 with no consecutive ones. ' +
          'derange: number of permutations of 1,2,3,4,5 where no value stays in its own position. ' +
          'recur: a(1)=1, and for n>1 a(n)=a(n-1)+n when n is even else a(n-1)*2; give a(6). ' +
          'modpow: 7^222 mod 100.',
      },
    ],
    temperature: 0,
    max_tokens: EVALUATION_MAX_TOKENS,
  };
  if (supported.has('reasoning') || supported.has('reasoning_effort')) {
    evaluationBody.reasoning = { effort: 'low' };
  }
  const result = await attemptJson(candidate, evaluationBody);
  const latencyMs = Date.now() - startedAt;
  recordUsage(candidate, result.ok ? 'ok' : result.kind || 'other');
  if (!result.ok) {
    // The refusal is the useful part when probing: it says whether the model is
    // offered for free at all, which no catalog on a price-free provider does.
    applyProviderVerdict(candidate, result);
    return {
      status: 'pending',
      version: EVALUATION_VERSION,
      attemptedAt: new Date().toISOString(),
      latencyMs,
      error: `${result.status} ${result.reason}`.slice(0, 300),
    };
  }
  // Serving the request is itself the proof, on a key with no billing.
  if (!PROVIDERS.get(candidate.provider)?.catalogHasPricing) {
    setModelVerdict(candidateKey(candidate), {
      free: true,
      reason: 'served a free-tier request',
    });
  }

  // Weights total 65 so scores stay on the same scale as the configured
  // baseline anchors. The last three items carry most of the discrimination;
  // the earlier ones are saturated by every competent model.
  const answers = parseEvaluationAnswers(evaluationText(result.payload));
  let benchmarkScore = 0;
  if (answers) benchmarkScore += 3;
  if (answers?.token === 'OX-RANK-7') benchmarkScore += 2;
  if (Number(answers?.crt) === 269) benchmarkScore += 8;
  if (String(answers?.trace) === '1-3') benchmarkScore += 8;
  if (Number(answers?.path) === 10) benchmarkScore += 6;
  if (Number(answers?.sequence) === 42) benchmarkScore += 4;
  if (Number(answers?.binary) === 55) benchmarkScore += 6;
  if (Number(answers?.derange) === 44) benchmarkScore += 10;
  if (Number(answers?.recur) === 26) benchmarkScore += 10;
  if (Number(answers?.modpow) === 49) benchmarkScore += 8;

  const modelMetadataScore = metadataScore(candidateMetadata(candidate));
  // Deliberately small: this is a single cold sample and used to swing the
  // ranking more than any capability signal did.
  const latencyScore = latencyMs <= 5000 ? 6 : latencyMs <= 15000 ? 4 : latencyMs <= 30000 ? 2 : 0;
  const score = Math.round((benchmarkScore + modelMetadataScore + latencyScore) * 10) / 10;
  return {
    status: 'scored',
    version: EVALUATION_VERSION,
    evaluatedAt: new Date().toISOString(),
    score,
    benchmarkScore,
    metadataScore: modelMetadataScore,
    latencyScore,
    latencyMs,
  };
}

// For a provider that publishes no prices, the only way to learn whether a
// model is free is to ask it. One request per candidate, verdict cached
// forever, so the cost is paid once per model rather than once per run.
async function probeFreeTierCandidates() {
  const configuredRoute = (config.routes?.[DISCOVERY_ROUTE] || []).map(normalizeCandidate);
  let budget = EVALUATION_MAX_PER_RUN;

  for (const provider of PROVIDERS.values()) {
    if (!provider.probeFreeTier || !provider.apiKey || !provider.catalog?.size) continue;

    const known = new Set(
      [
        ...provider.freeModels,
        ...configuredRoute
          .filter((candidate) => candidate.provider === provider.name)
          .map((candidate) => candidate.model),
        ...discoveredModelIds.map((id) => discoveredCandidate(id).model),
      ].map(normalizeModelSlug),
    );

    const candidates = [];
    for (const model of provider.catalog.values()) {
      if (budget <= 0) break;
      // Compared by slug, because a catalog id and the id used for chat need
      // not match character for character. Raw string comparison re-probes
      // models that are already routed and adds a duplicate entry for them.
      if (known.has(normalizeModelSlug(model.id))) continue;
      // Already answered: no second request until that answer goes stale.
      if (verdictFor(`${provider.name}:${model.id}`)) continue;
      if (!isChatModel(model)) continue;
      const reason = discoveryExclusionReason(`${provider.name}:${model.id}`);
      if (reason) continue;
      candidates.push(model.id);
      budget -= 1;
    }
    if (!candidates.length) continue;

    log(`probing ${candidates.length} ${provider.name} model(s) for free-tier access`, candidates);
    for (const model of candidates) {
      const candidate = { provider: provider.name, model };
      const key = candidateKey(candidate);
      const evaluation = await evaluateModel(candidate);
      if (modelVerdicts[key]?.free === false) continue;
      if (evaluation.status !== 'scored') {
        log(`probe inconclusive for ${key}: ${evaluation.error}`);
        continue;
      }
      modelEvaluations[model] = evaluation;
      if (!discoveredModelIds.includes(key)) discoveredModelIds.push(key);
      log(`${key} is free: score ${evaluation.score}`);
      saveDiscoveryState();
    }
  }
}

async function performFreeModelDiscovery(forceCatalogRefresh = false) {
  if (!DISCOVERY_ENABLED) return;
  if (
    discoveryLastCheckedAt &&
    Date.now() - discoveryLastCheckedAt < DISCOVERY_INTERVAL_MS
  ) {
    return;
  }

  try {
    if (forceCatalogRefresh || !registry.discoveryCatalog()?.catalog.size) {
      await refreshCatalog(true);
    }
    const catalogProvider = registry.discoveryCatalog();
    const catalog = catalogProvider?.catalog || new Map();
    if (!catalog.size || catalogProvider?.catalogError) {
      throw new Error(catalogProvider?.catalogError || 'catalog is empty');
    }

    const configured = config.routes?.[DISCOVERY_ROUTE];
    if (!Array.isArray(configured)) {
      throw new Error(`discovery route does not exist: ${DISCOVERY_ROUTE}`);
    }
    const configuredCatalogIds = configured
      .map(normalizeCandidate)
      .filter((candidate) => candidate.provider === registry.discoveryProvider)
      .map((candidate) => candidate.model);

    const freeIds = [...catalog.values()]
      .filter((model) => isZeroCost(model) && isChatModel(model))
      .map((model) => model.id)
      .filter((id) => typeof id === 'string' && id)
      .sort();
    const eligible = new Set(freeIds);
    // Configured models are exempt: an explicit config entry beats the filter.
    const configuredCatalogSet = new Set(configuredCatalogIds);
    const excluded = new Map();
    for (const id of freeIds) {
      if (configuredCatalogSet.has(id)) continue;
      const reason = discoveryExclusionReason(id);
      if (reason) excluded.set(id, reason);
    }
    discoveryExcludedIds = [...excluded.keys()];
    if (excluded.size) {
      log(
        `excluding ${excluded.size} domain-specific model(s) from ${DISCOVERY_ROUTE}`,
        [...excluded].map(([id, reason]) => `${id} (${reason})`),
      );
    }

    // `eligible` is this one catalog's zero-cost list, so it can only judge
    // this catalog's models. Entries discovered by probing another provider are
    // governed by that provider's verdict and must survive this pass untouched.
    const fromCatalogProvider = (id) =>
      discoveredCandidate(id).provider === registry.discoveryProvider;
    const catalogDiscovered = discoveredModelIds.filter(fromCatalogProvider);
    const allRouted = [...new Set([...configuredCatalogIds, ...catalogDiscovered])];
    discoveryRemovedIds = allRouted.filter((id) => !eligible.has(id));
    discoveredModelIds = discoveredModelIds.filter(
      (id) => !fromCatalogProvider(id) || (eligible.has(id) && !excluded.has(id)),
    );
    if (discoveryRemovedIds.length) {
      log(
        `removed ${discoveryRemovedIds.length} non-free or unavailable model(s) from active routes`,
        discoveryRemovedIds,
      );
    }
    const routed = new Set([...configuredCatalogIds, ...catalogDiscovered]);
    const knownSlugs = new Set(
      [
        ...configured.map(normalizeCandidate).map((candidate) => normalizeModelSlug(candidate.model)),
        ...catalogDiscovered.map((id) => normalizeModelSlug(id)),
      ].filter(Boolean),
    );
    const additions = freeIds.filter(
      (id) => !routed.has(id) && !knownSlugs.has(normalizeModelSlug(id)) && !excluded.has(id),
    );
    if (additions.length) {
      discoveredModelIds.push(...additions);
      log(`discovered ${additions.length} free model(s); evaluating for ${DISCOVERY_ROUTE}`, additions);
    } else {
      log(`free-model discovery complete: no additions for ${DISCOVERY_ROUTE}`);
    }

    // A model whose one evaluation attempt failed used to keep score -1 forever,
    // because it was already in discoveredModelIds and so never reappeared in
    // `additions`. Retry those, plus anything scored on an older benchmark.
    const addedSet = new Set(additions);
    // Scores are keyed by bare model id, since a benchmark result describes the
    // model rather than the provider serving it, while route entries may carry
    // a `provider:` prefix once more than one provider contributes models.
    const stale = discoveredModelIds.filter((id) => {
      if (addedSet.has(id)) return false;
      const evaluation = modelEvaluations[discoveredCandidate(id).model];
      return evaluation?.status !== 'scored' || evaluation.version !== EVALUATION_VERSION;
    });
    const toEvaluate = [...additions, ...stale].slice(0, EVALUATION_MAX_PER_RUN);
    if (EVALUATION_ENABLED && toEvaluate.length) {
      if (stale.length) {
        log(`re-evaluating ${stale.length} model(s) with missing or outdated scores`, stale);
      }
      for (const id of toEvaluate) {
        const candidate = discoveredCandidate(id);
        log(`evaluating ${addedSet.has(id) ? 'newly discovered' : 'stale'} model ${id}`);
        const evaluation = await evaluateModel(candidate);
        modelEvaluations[candidate.model] = evaluation;
        if (evaluation.status === 'scored') {
          log(`evaluated ${id}: score ${evaluation.score}`);
        } else {
          log(`evaluation deferred for ${id}: ${evaluation.error}`);
        }
        saveDiscoveryState();
      }
    }

    discoverySeenIds = freeIds;
    discoveryError = '';
  } catch (error) {
    discoveryError = error instanceof Error ? error.message : String(error);
    log(`free-model discovery failed: ${discoveryError}`);
  }

  // Runs regardless of the priced catalog's outcome, since it depends on a
  // different provider and a failure there says nothing about this.
  if (EVALUATION_ENABLED) {
    try {
      await probeFreeTierCandidates();
    } catch (error) {
      log(`free-tier probing failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Timestamped once the whole run is over, so the interval measures complete
  // runs and an observer waiting on it cannot see a half-finished one.
  discoveryLastCheckedAt = Date.now();
  saveDiscoveryState();
}

function discoverFreeModels(forceCatalogRefresh = false) {
  if (discoveryInFlight) return discoveryInFlight;
  discoveryInFlight = performFreeModelDiscovery(forceCatalogRefresh).finally(() => {
    discoveryInFlight = null;
  });
  return discoveryInFlight;
}

function scheduleNextDiscovery() {
  if (!DISCOVERY_ENABLED) return;
  const elapsed = discoveryLastCheckedAt ? Date.now() - discoveryLastCheckedAt : 0;
  const delay = discoveryLastCheckedAt
    ? Math.max(1000, DISCOVERY_INTERVAL_MS - elapsed)
    : Math.min(DISCOVERY_INTERVAL_MS, 60 * 60 * 1000);
  const timer = setTimeout(async () => {
    await discoverFreeModels(true);
    scheduleNextDiscovery();
  }, delay);
  timer.unref();
}

loadDiscoveryState();

function requestNeeds(body) {
  const modalities = new Set();
  let hasImages = false;
  let hasVideo = false;
  for (const message of body.messages || []) {
    if (!Array.isArray(message?.content)) continue;
    for (const part of message.content) {
      if (part?.type === 'image_url' || part?.type === 'input_image') hasImages = true;
      if (part?.type === 'video_url' || part?.type === 'input_video') hasVideo = true;
    }
  }
  if (hasImages) modalities.add('image');
  if (hasVideo) modalities.add('video');
  return {
    tools: Array.isArray(body.tools) && body.tools.length > 0,
    responseFormat: Boolean(body.response_format),
    modalities,
  };
}

function cooldownRemaining(candidate) {
  const key = candidateKey(candidate);
  const entry = cooldowns.get(key);
  if (!entry) return 0;
  const remaining = entry.until - Date.now();
  if (remaining <= 0) {
    cooldowns.delete(key);
    return 0;
  }
  return remaining;
}

function setCooldown(candidate, kind, reason, overrideMs = 0) {
  const durations = config.cooldownMs || {};
  const duration = overrideMs || Number(durations[kind] || 0);
  if (!duration) return;
  cooldowns.set(candidateKey(candidate), {
    until: Date.now() + duration,
    kind,
    reason: String(reason || '').slice(0, 300),
  });
}

// A provider that explains its own refusal is worth listening to. Turns one
// failed attempt into three separate decisions: how long to wait, whether the
// model is free at all, and what its real daily allowance is.
function applyProviderVerdict(candidate, result) {
  const key = candidateKey(candidate);
  const body = result.errorBody;
  if (!body) return 0;

  const permanent = permanentRejection(result.status, body);
  if (permanent) {
    setModelVerdict(key, { free: false, reason: permanent });
    log(`excluding ${key}: ${permanent}`);
    return 0;
  }

  const quota = parseQuotaFailure(body);
  if (!quota) return 0;

  if (quota.noFreeTier) {
    // Every free-tier allowance is zero, so no amount of waiting helps.
    setModelVerdict(key, { free: false, reason: 'no free-tier allowance (limit 0)' });
    log(`excluding ${key}: provider reports no free-tier quota`);
    return 0;
  }

  // The allowance exists, which is itself proof the model is free.
  const verdict = { free: true, reason: 'free-tier quota reported by provider' };
  if (quota.dailyRequestLimit) verdict.dailyRequestLimit = quota.dailyRequestLimit;
  setModelVerdict(key, verdict);

  if (quota.exhaustedWindow === 'day') {
    const wait = msUntilQuotaReset(Date.now(), USAGE_TIMEZONE || 'America/Los_Angeles');
    log(`${key} spent its daily free quota; waiting ${Math.round(wait / 60000)}m for reset`);
    return wait;
  }
  return quota.retryDelayMs;
}

function candidateModels(requestedModel, body) {
  const configured = routeCandidates(requestedModel);
  return filterCandidates(configured || registry.directCandidates(requestedModel), body, requestedModel);
}

function filterCandidates(configured, body, requestedModel) {
  const needs = requestNeeds(body);
  const active = [];
  const skipped = [];
  for (const candidate of configured) {
    const model = candidateMetadata(candidate);
    if (!candidateIsFree(candidate)) {
      skipped.push({ model: candidateKey(candidate), reason: 'not currently zero-cost or missing key' });
      continue;
    }
    if (!supportsRequest(model, needs)) {
      skipped.push({ model: candidateKey(candidate), reason: 'missing requested capability' });
      continue;
    }
    const remaining = cooldownRemaining(candidate);
    if (remaining > 0) {
      skipped.push({
        model: candidateKey(candidate),
        reason: `cooldown ${Math.ceil(remaining / 1000)}s`,
      });
      continue;
    }
    active.push(candidate);
  }

  // If every compatible model is cooling down, retry them in order instead of
  // turning a temporary cooldown into a hard outage.
  if (!active.length) {
    for (const candidate of configured) {
      if (
        candidateIsFree(candidate) &&
        supportsRequest(candidateMetadata(candidate), needs)
      ) {
        active.push(candidate);
      }
    }
  }

  if (skipped.length) log(`${requestedModel}: skipped ${skipped.length} candidate(s)`, skipped);
  return active;
}

function sanitizeUpstreamBody(body, candidate) {
  const upstream = JSON.parse(
    JSON.stringify({
      ...body,
      model: candidate.model,
    }),
  );
  delete upstream.models;
  delete upstream.route;
  if (providerNeedsThoughtSignatures(PROVIDERS.get(candidate.provider))) {
    injectThoughtSignatures(upstream, thoughtSignatures);
  }
  if (!secretRedactor) return upstream;
  const { value, count } = secretRedactor.redact(upstream);
  if (count) log(`redacted ${count} secret occurrence(s) before upstream`);
  return value;
}

function rememberGeminiSignatures(candidate, payload) {
  if (!providerNeedsThoughtSignatures(PROVIDERS.get(candidate.provider))) return;
  rememberSignaturesFromPayload(payload, thoughtSignatures);
}

function geminiStreamExtractor(candidate) {
  if (!providerNeedsThoughtSignatures(PROVIDERS.get(candidate.provider))) return null;
  return createStreamSignatureExtractor((id, signature) => {
    thoughtSignatures.remember(id, signature);
  });
}

function usefulMessage(payload) {
  const choice = payload?.choices?.[0];
  const message = choice?.message;
  if (!message) return false;
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) return true;
  if (typeof message.content === 'string' && message.content.trim()) return true;
  if (Array.isArray(message.content) && message.content.length) {
    return message.content.some((part) => {
      if (typeof part === 'string') return part.trim();
      return typeof part?.text === 'string' && part.text.trim();
    });
  }
  return false;
}

function usefulDelta(payload) {
  const delta = payload?.choices?.[0]?.delta;
  if (!delta) return false;
  if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) return true;
  if (typeof delta.content === 'string' && delta.content.length) return true;
  if (Array.isArray(delta.content) && delta.content.length) return true;
  return false;
}

function classifyFailure(status, message, timedOut = false) {
  if (timedOut) return 'timeout';
  if (status === 429) return 'rateLimit';
  if (status === 404) return 'notFound';
  if (status === 403) return 'forbidden';
  if (status >= 500) return 'serverError';
  if (/empty|reasoning only|no useful/i.test(message)) return 'empty';
  return '';
}

// Gemini's OpenAI-compatible layer returns errors wrapped in a single-element
// array, so an `error.message` lookup finds nothing and the real reason is lost.
function parseErrorPayload(raw) {
  try {
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed) ? parsed[0] : parsed) ?? null;
  } catch {
    return null;
  }
}

function errorSummary(status, raw) {
  const parsed = parseErrorPayload(raw);
  if (!parsed) return raw.trim().slice(0, 500) || `HTTP ${status}`;
  return (
    parsed?.error?.metadata?.raw ||
    parsed?.error?.message ||
    parsed?.message ||
    `HTTP ${status}`
  );
}

async function fetchModel(candidate, body, clientSignal) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('attempt timeout')), ATTEMPT_TIMEOUT_MS);
  const abortFromClient = () => controller.abort(new Error('client disconnected'));
  clientSignal?.addEventListener('abort', abortFromClient, { once: true });
  const cleanup = () => {
    clearTimeout(timer);
    clientSignal?.removeEventListener('abort', abortFromClient);
  };
  try {
    const provider = PROVIDERS.get(candidate.provider);
    if (!provider?.baseUrl || !provider.apiKey) {
      throw new Error(`provider ${candidate.provider} is not configured`);
    }
    const response = await fetch(registry.chatUrl(candidate.provider), {
      method: 'POST',
      headers: registry.headers(candidate.provider),
      body: JSON.stringify(sanitizeUpstreamBody(body, candidate)),
      signal: controller.signal,
    });
    return { response, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function attemptJson(candidate, body, clientSignal) {
  let response;
  let cleanup = () => {};
  try {
    ({ response, cleanup } = await fetchModel(
      candidate,
      { ...body, stream: false },
      clientSignal,
    ));
  } catch (error) {
    const timedOut = error?.name === 'AbortError' || /timeout/i.test(String(error));
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      reason: timedOut ? 'attempt timeout' : String(error),
      kind: classifyFailure(0, String(error), timedOut),
    };
  }
  let raw;
  try {
    raw = await response.text();
  } catch (error) {
    const timedOut = error?.name === 'AbortError' || /timeout/i.test(String(error));
    cleanup();
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      reason: timedOut ? 'attempt timeout' : String(error),
      kind: classifyFailure(0, String(error), timedOut),
    };
  }
  cleanup();
  if (!response.ok) {
    const reason = errorSummary(response.status, raw);
    return {
      ok: false,
      status: response.status,
      reason,
      kind: classifyFailure(response.status, reason),
      fatal: response.status === 401,
      // Kept so the caller can read what the provider said about its own
      // quotas instead of only seeing a status code.
      errorBody: parseErrorPayload(raw),
    };
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { ok: false, status: 502, reason: 'invalid JSON response', kind: 'serverError' };
  }
  if (!usefulMessage(payload)) {
    const finish = payload?.choices?.[0]?.finish_reason || 'unknown';
    return {
      ok: false,
      status: 502,
      reason: `no useful content or tool call (finish_reason=${finish})`,
      kind: 'empty',
    };
  }
  rememberGeminiSignatures(candidate, payload);
  return {
    ok: true,
    payload,
    contentType: response.headers.get('content-type') || 'application/json',
  };
}

async function attemptStream(candidate, body, res, clientSignal) {
  let response;
  let cleanup = () => {};
  try {
    ({ response, cleanup } = await fetchModel(
      candidate,
      { ...body, stream: true },
      clientSignal,
    ));
  } catch (error) {
    const timedOut = error?.name === 'AbortError' || /timeout/i.test(String(error));
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      reason: timedOut ? 'attempt timeout' : String(error),
      kind: classifyFailure(0, String(error), timedOut),
    };
  }

  if (!response.ok) {
    let raw;
    try {
      raw = await response.text();
    } finally {
      cleanup();
    }
    const reason = errorSummary(response.status, raw);
    return {
      ok: false,
      status: response.status,
      reason,
      kind: classifyFailure(response.status, reason),
      fatal: response.status === 401,
      errorBody: parseErrorPayload(raw),
    };
  }
  if (!response.body) {
    cleanup();
    return { ok: false, status: 502, reason: 'empty response body', kind: 'empty' };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const extractor = geminiStreamExtractor(candidate);
  const bufferedChunks = [];
  let parserBuffer = '';
  let committed = false;
  let finishReason = '';

  while (true) {
    let read;
    try {
      read = await reader.read();
    } catch (error) {
      extractor?.flush();
      cleanup();
      if (committed) {
        res.end();
        return { ok: true, candidate, interrupted: true };
      }
      return { ok: false, status: 502, reason: String(error), kind: 'serverError' };
    }
    if (read.done) break;
    const bytes = Buffer.from(read.value);
    const text = decoder.decode(read.value, { stream: true });
    extractor?.push(text);
    if (committed) {
      res.write(bytes);
      continue;
    }

    bufferedChunks.push(bytes);
    parserBuffer += text;
    const lines = parserBuffer.split('\n');
    parserBuffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const data = trimmed.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const payload = JSON.parse(data);
        const finish = payload?.choices?.[0]?.finish_reason;
        if (finish) finishReason = finish;
        if (usefulDelta(payload)) {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-transform',
            Connection: 'keep-alive',
            'X-Free-Router-Model': candidate.model,
            'X-Free-Router-Provider': candidate.provider,
          });
          for (const chunk of bufferedChunks) res.write(chunk);
          bufferedChunks.length = 0;
          committed = true;
          log(`selected ${candidateKey(candidate)} (stream)`);
          break;
        }
      } catch {
        // Ignore keepalives and malformed provider-specific event lines.
      }
    }
  }

  extractor?.flush();
  if (committed) {
    cleanup();
    res.end();
    return { ok: true, candidate };
  }
  cleanup();
  return {
    ok: false,
    status: 502,
    reason: `reasoning only or empty stream (finish_reason=${finishReason || 'unknown'})`,
    kind: 'empty',
  };
}

function sendJson(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    ...headers,
  });
  res.end(body);
}

async function readJson(req, limit = 10 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('request body too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function routeStatus() {
  const now = Date.now();
  const routes = {};
  for (const name of Object.keys(config.routes || {})) {
    const candidates = routeCandidates(name) || [];
    const configured = (config.routes[name] || []).map(normalizeCandidate);
    const configuredKeys = configured.map(candidateKey);
    const configuredSet = new Set(configuredKeys);
    const configuredIndex = new Map(configuredKeys.map((key, index) => [key, index]));
    routes[name] = candidates.map((candidate, priority) => {
      const key = candidateKey(candidate);
      const model = candidateMetadata(candidate);
      const cooldown = cooldowns.get(key);
      const pinned = PINNED_MODELS.has(key) || PINNED_MODELS.has(candidate.model);
      return {
        priority: priority + 1,
        provider: candidate.provider,
        id: candidate.model,
        pinned,
        score: pinned
          ? null
          : rankedModelScore(key, configuredSet, configuredIndex),
        baseScore: pinned ? null : baseModelScore(key, configuredSet, configuredIndex),
        scoreAdjustment: pinned ? 0 : usageAdjustment(key),
        scoreSource: scoreSourceFor(key, configuredSet),
        // Only meaningful where the catalog publishes prices; elsewhere the
        // freeModels allowlist is the guarantee, so report it as free.
        zeroCost: PROVIDERS.get(candidate.provider)?.catalogHasPricing
          ? model
            ? isZeroCost(model)
            : null
          : true,
        supportsTools: model ? (model.supported_parameters || []).includes('tools') : null,
        cooldownSeconds:
          cooldown && cooldown.until > now ? Math.ceil((cooldown.until - now) / 1000) : 0,
        cooldownReason: cooldown?.reason,
        usage: usageForKey(key),
      };
    });
  }
  return routes;
}

async function handleChat(req, res) {
  let body;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, {
      error: { message: String(error), type: 'invalid_request_error' },
    });
  }

  const requestedModel = String(body.model || 'free-best');
  await refreshCatalog();
  const candidates = candidateModels(requestedModel, body);
  if (!candidates.length) {
    return sendJson(res, 503, {
      error: {
        message: `No currently free model supports this request for route ${requestedModel}`,
        type: 'no_compatible_free_model',
      },
    });
  }

  const failures = [];
  const failedProviders = new Set();
  const clientController = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) clientController.abort();
  });

  for (const candidate of candidates) {
    if (clientController.signal.aborted) return;
    if (failedProviders.has(candidate.provider)) continue;
    log(`trying ${candidateKey(candidate)} for ${requestedModel}`);
    const result = body.stream
      ? await attemptStream(candidate, body, res, clientController.signal)
      : await attemptJson(candidate, body, clientController.signal);

    if (result.ok) {
      recordUsage(candidate, 'ok');
      rememberSelection({
        route: requestedModel,
        provider: candidate.provider,
        model: candidate.model,
        selectedAt: new Date().toISOString(),
      });
      if (!body.stream) {
        log(`selected ${candidateKey(candidate)}`);
        return sendJson(res, 200, result.payload, {
          'X-Free-Router-Model': candidate.model,
          'X-Free-Router-Provider': candidate.provider,
        });
      }
      return;
    }

    recordUsage(
      candidate,
      clientController.signal.aborted ? 'aborted' : result.kind || 'other',
    );
    failures.push({
      provider: candidate.provider,
      model: candidate.model,
      status: result.status,
      reason: result.reason,
    });
    const providerWaitMs = applyProviderVerdict(candidate, result);
    if (result.kind) setCooldown(candidate, result.kind, result.reason, providerWaitMs);
    log(`failed ${candidateKey(candidate)}: ${result.status} ${result.reason}`);
    if (result.fatal) failedProviders.add(candidate.provider);
    // The same history will 400 on every Gemini thinking model. Stop here so
    // 3.8-flash, 3.7-flash, and Flash-Lite are not each billed for a refusal.
    if (isMissingThoughtSignatureError(result.status, result.reason)) {
      log(`skipping remaining ${candidate.provider} candidates: missing thought_signature`);
      failedProviders.add(candidate.provider);
    }
  }

  if (!res.headersSent) {
    sendJson(res, 502, {
      error: {
        message: `All models failed for route ${requestedModel}`,
        type: 'free_router_exhausted',
        failures,
      },
    });
  }
}

function isLoopbackAddress(address) {
  const plain = String(address || '').replace(/^::ffff:/, '');
  return plain === '::1' || plain === '127.0.0.1' || plain.startsWith('127.');
}

// Constant-time so the token cannot be recovered one character at a time from
// response timing. The length check is not a leak: timingSafeEqual requires
// equal lengths and throws otherwise.
function bearerMatches(req) {
  if (!API_TOKEN) return false;
  const header = String(req.headers.authorization || '');
  if (!/^bearer\s+/i.test(header)) return false;
  const presented = Buffer.from(header.replace(/^bearer\s+/i, '').trim());
  const expected = Buffer.from(API_TOKEN);
  return presented.length === expected.length && crypto.timingSafeEqual(presented, expected);
}

// The router has no caller authentication, so any page the user visits could
// otherwise drive these endpoints. Four checks, strongest first:
//   - a valid bearer token, which is the only one that works once the
//     container sits behind a platform proxy that is not on loopback;
//   - the peer must be on loopback, even if the listener was bound wider;
//   - the Host header must be a loopback name, which blocks DNS rebinding;
//   - the request must not be cross-site, which blocks browser-driven CSRF.
// A plain curl call sends neither Origin nor Sec-Fetch-Site and is allowed.
function uiGuardFailure(req) {
  if (bearerMatches(req)) return '';
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return 'requests must come from loopback';

  const host = String(req.headers.host || '');
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (hostname && hostname !== 'localhost' && !isLoopbackAddress(hostname)) {
    return `unexpected Host header: ${host}`;
  }

  const site = String(req.headers['sec-fetch-site'] || '');
  if (site && site !== 'same-origin' && site !== 'none') {
    return `cross-site request blocked (Sec-Fetch-Site: ${site})`;
  }

  const origin = String(req.headers.origin || '');
  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).hostname;
    } catch {
      return `invalid Origin header: ${origin}`;
    }
    if (originHost !== 'localhost' && !isLoopbackAddress(originHost)) {
      return `unexpected Origin header: ${origin}`;
    }
  }
  return '';
}

function uiProviderState() {
  const catalogHealth = registry.health();
  const providers = [...PROVIDERS.values()];
  providers.sort((left, right) => Number(right.name === 'gemini') - Number(left.name === 'gemini'));
  return providers.map((provider) => ({
    name: provider.name,
    keyEnv: provider.keyEnv,
    baseUrl: provider.baseUrl,
    kind: registry.providerKind(provider),
    configured: Boolean(provider.apiKey),
    maskedKey: maskSecret(provider.apiKey),
    catalogModels: provider.usesCatalog ? provider.catalog.size : null,
    catalogError: catalogHealth[provider.name]?.catalogError || null,
    unavailableModels: catalogHealth[provider.name]?.unavailableModels || [],
  }));
}

function uiRouteState() {
  const routes = routeStatus();
  const entries = routes[DISCOVERY_ROUTE] || Object.values(routes)[0] || [];
  return entries.map((entry) => ({
    priority: entry.priority,
    provider: entry.provider,
    model: entry.id,
    pinned: entry.pinned,
    zeroCost: entry.zeroCost,
    cooldownSeconds: entry.cooldownSeconds,
    scoreAdjustment: entry.scoreAdjustment,
    providerConfigured: Boolean(PROVIDERS.get(entry.provider)?.apiKey),
    usage: entry.usage,
  }));
}

async function handleKeyUpdate(req, res) {
  let body;
  try {
    body = await readJson(req, 64 * 1024);
  } catch (error) {
    return sendJson(res, 400, {
      error: { message: String(error), type: 'invalid_request_error' },
    });
  }

  const name = String(body.provider || '');
  const provider = PROVIDERS.get(name);
  // Whitelisted by provider name, never by raw env name: start.sh sources the
  // env file with `set -a`, so writing an arbitrary variable such as
  // NODE_OPTIONS would be code execution on the next start.
  if (!provider) {
    return sendJson(res, 400, {
      error: {
        message: `unknown provider: ${name || '(missing)'}`,
        type: 'invalid_request_error',
      },
    });
  }

  const key = typeof body.key === 'string' ? body.key.trim() : '';
  const problem = validateSecret(key);
  if (problem) {
    return sendJson(res, 400, { error: { message: problem, type: 'invalid_request_error' } });
  }

  try {
    updateEnvFile(UI_ENV_PATH, { [provider.keyEnv]: key });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`failed to write ${displayPath(UI_ENV_PATH)}: ${reason}`);
    return sendJson(res, 500, {
      error: { message: `could not write env file: ${reason}`, type: 'env_write_failed' },
    });
  }

  registry.setApiKey(name, key);
  refreshSecretRedactor();
  log(`${key ? 'set' : 'cleared'} ${provider.keyEnv} via web interface`);
  if (key && provider.usesCatalog) {
    try {
      await refreshCatalog(true);
    } catch (error) {
      log(`catalog refresh after key change failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return sendJson(res, 200, { ok: true, provider: name, configured: Boolean(key) });
}

async function handler(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const isUiPath = url.pathname === '/' || url.pathname.startsWith('/api/');
  if (isUiPath) {
    if (!UI_ENABLED) {
      return sendJson(res, 404, {
        error: { message: 'web interface is disabled', type: 'not_found' },
      });
    }
    const failure = uiGuardFailure(req);
    if (failure) {
      log(`blocked web interface request: ${failure}`);
      return sendJson(res, 403, { error: { message: failure, type: 'forbidden' } });
    }
  }

  // With a secret configured, everything outside the guarded UI needs it.
  // Otherwise /health publishes the whole provider layout and /v1/chat/
  // completions spends the operator's upstream quota for whoever asked.
  if (API_TOKEN && !isUiPath && !bearerMatches(req)) {
    return sendJson(res, 401, {
      error: {
        message: 'Incorrect API key provided. Send it as "Authorization: Bearer <token>".',
        type: 'invalid_api_key',
      },
    });
  }

  if (req.method === 'GET' && url.pathname === '/') {
    const page = renderPage();
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(page),
      'Cache-Control': 'no-store',
      'Content-Security-Policy':
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
    });
    return res.end(page);
  }
  if (req.method === 'GET' && url.pathname === '/api/state') {
    await refreshCatalog();
    return sendJson(
      res,
      200,
      {
        endpoint: `http://${HOST}:${PORT}/v1`,
        envFile: displayPath(UI_ENV_PATH),
        route: DISCOVERY_ROUTE,
        providers: uiProviderState(),
        usage: usageSummary(),
        routes: uiRouteState(),
        unavailableModels: discoveryUnavailableIds,
        excludedByProvider: rejectedConfiguredModels(),
        lastSelection,
      },
      { 'Cache-Control': 'no-store' },
    );
  }
  if (req.method === 'POST' && url.pathname === '/api/keys') {
    return handleKeyUpdate(req, res);
  }
  if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/v1/health')) {
    return sendJson(res, 200, {
      ok: true,
      service: 'free-router',
      version: VERSION,
      defaultProvider: registry.defaultProvider,
      catalogModels: registry.discoveryCatalog()?.catalog.size || 0,
      catalogFetchedAt: registry.discoveryCatalog()?.catalogFetchedAt
        ? new Date(registry.discoveryCatalog().catalogFetchedAt).toISOString()
        : null,
      catalogError: registry.discoveryCatalog()?.catalogError || null,
      providers: registry.health(),
      discovery: {
        enabled: DISCOVERY_ENABLED,
        provider: registry.discoveryProvider,
        route: DISCOVERY_ROUTE,
        intervalMs: DISCOVERY_INTERVAL_MS,
        lastCheckedAt: discoveryLastCheckedAt
          ? new Date(discoveryLastCheckedAt).toISOString()
          : null,
        freeModelsSeen: discoverySeenIds.length,
        addedModels: discoveredModelIds,
        removedModels: discoveryRemovedIds,
        excludedModels: excludedModelIds(),
        unavailableModels: discoveryUnavailableIds,
        modelVerdicts,
        // Which providers can contribute new models, and which are only
        // checked for models that disappeared.
        addsFrom: [...PROVIDERS.values()].filter((p) => p.discover).map((p) => p.name),
        availabilityOnly: [...PROVIDERS.values()]
          .filter((p) => p.usesCatalog && !p.catalogHasPricing)
          .map((p) => p.name),
        evaluations: modelEvaluations,
        error: discoveryError || null,
      },
      lastSelection,
      usage: usageSummary(),
      routes: routeStatus(),
    });
  }
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    await refreshCatalog();
    const routeModels = Object.keys(config.routes || {}).map((id) => ({
      id,
      object: 'model',
      created: 0,
      owned_by: 'free-router',
    }));
    const listed = registry.listListedModels();
    const catalogModels = registry.listCatalogModels(listed.ids).map((model) => ({
      id: model.id,
      object: model.object,
      created: model.created,
      owned_by: model.owned_by,
      context_length: model.context_length,
    }));
    return sendJson(res, 200, {
      object: 'list',
      data: [...routeModels, ...listed.models, ...catalogModels],
    });
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    return handleChat(req, res);
  }
  return sendJson(res, 404, {
    error: { message: `Unknown endpoint: ${req.method} ${url.pathname}`, type: 'not_found' },
  });
}

const server = http.createServer((req, res) => {
  handler(req, res).catch((error) => {
    log('unhandled request error', error);
    if (!res.headersSent) {
      sendJson(res, 500, {
        error: { message: 'Internal router error', type: 'router_internal_error' },
      });
    } else {
      res.end();
    }
  });
});

server.requestTimeout = 0;
server.headersTimeout = 65000;
server.keepAliveTimeout = 5000;

server.listen(PORT, HOST, async () => {
  log(`Free Router ${VERSION} listening on http://${HOST}:${PORT}/v1`);
  if (UI_ENABLED) log(`web interface on http://${HOST}:${PORT}/`);
  // The one misconfiguration worth shouting about: a non-loopback bind with no
  // secret means the endpoint spends the operator's quota for anyone.
  if (!isLoopbackAddress(HOST) && !API_TOKEN) {
    log(
      `warning: bound to ${HOST} with no FREE_ROUTER_API_KEY; ` +
        '/v1 and /health are reachable by anyone who can reach this host',
    );
  } else if (API_TOKEN) {
    log('caller authentication enabled (FREE_ROUTER_API_KEY)');
  }
  for (const provider of PROVIDERS.values()) {
    if (!provider.apiKey) log(`warning: ${provider.keyEnv} is missing`);
  }
  await refreshCatalog(true);
  await discoverFreeModels();
  scheduleNextDiscovery();
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`received ${signal}; shutting down`);
    if (stateSaveTimer) flushStateSave();
    server.close(() => process.exit(0));
  });
}
