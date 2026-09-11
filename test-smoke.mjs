#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createProviderRegistry, isChatModel, normalizeCatalogPayload, normalizeModelSlug, supportsRequest } from './providers.mjs';
import { msUntilQuotaReset, parseQuotaFailure, permanentRejection } from './quota.mjs';
import {
  SKIP_THOUGHT_SIGNATURE,
  createStreamSignatureExtractor,
  createThoughtSignatureCache,
  injectThoughtSignatures,
  isMissingThoughtSignatureError,
  providerNeedsThoughtSignatures,
  readThoughtSignature,
  rememberSignaturesFromPayload,
} from './thought-signature.mjs';
import { displayPath, maskSecret, validateSecret } from './ui.mjs';

const PACKAGE_VERSION = JSON.parse(
  fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json'), 'utf8'),
).version;
assert.match(PACKAGE_VERSION, /^\d+\.\d+\.\d+$/);

assert.equal(normalizeModelSlug('google/gemini-3.8-flash:free'), 'gemini-3.8-flash');
assert.equal(normalizeModelSlug('gemini-3.8-flash'), 'gemini-3.8-flash');
assert.equal(normalizeModelSlug('acme/extra-1:free'), 'extra-1');

// Google's native listing, in the shape the live API returns it.
const googleCatalog = normalizeCatalogPayload({
  models: [
    {
      name: 'models/gemini-3.8-flash',
      displayName: 'Gemini 3.8 Flash',
      description: 'Fast general model.',
      inputTokenLimit: 1048576,
      outputTokenLimit: 65536,
      supportedGenerationMethods: ['generateContent', 'countTokens'],
    },
    {
      name: 'models/gemini-embedding-2',
      supportedGenerationMethods: ['embedContent', 'countTextTokens'],
    },
    {
      name: 'models/veo-3.1-generate-preview',
      supportedGenerationMethods: ['predictLongRunning'],
    },
    {
      name: 'models/gemini-3.1-flash-live-preview',
      supportedGenerationMethods: ['bidiGenerateContent'],
    },
  ],
});
assert.equal(googleCatalog.shape, 'google');
// The "models/" prefix is dropped so catalog IDs match what config.json and
// the chat endpoint use.
assert.deepEqual(
  googleCatalog.models.map((model) => model.id),
  ['gemini-3.8-flash', 'gemini-embedding-2', 'veo-3.1-generate-preview', 'gemini-3.1-flash-live-preview'],
);
assert.equal(googleCatalog.models[0].context_length, 1048576);
// Declared generation methods decide chat capability; embeddings, video, and
// live audio are excluded without naming them anywhere.
assert.deepEqual(googleCatalog.models.map(isChatModel), [true, false, false, false]);
// A listing with no prices must never read as free.
assert.equal(googleCatalog.models[0].pricing, undefined);
// And no OpenAI-style parameter list: treating that as "no tools" would skip
// Gemini on every agent request and dump traffic onto whatever has no catalog.
assert.equal(googleCatalog.models[0].supported_parameters, undefined);
{
  const tools = { tools: true, responseFormat: false, modalities: new Set() };
  const images = { tools: false, responseFormat: false, modalities: new Set(['image']) };
  assert.equal(supportsRequest(googleCatalog.models[0], tools), true);
  assert.equal(supportsRequest(googleCatalog.models[0], images), true);
  assert.equal(supportsRequest({ supported_parameters: [] }, tools), true);
  assert.equal(supportsRequest(null, tools), true);
  assert.equal(supportsRequest({ supported_parameters: ['response_format'] }, tools), false);
  assert.equal(supportsRequest({ supported_parameters: ['tools'] }, tools), true);
  assert.equal(
    supportsRequest({ architecture: { input_modalities: ['text'] } }, images),
    false,
  );
}

const openaiCatalog = normalizeCatalogPayload({ data: [{ id: 'a' }, { nope: 1 }] });
assert.equal(openaiCatalog.shape, 'openai');
assert.deepEqual(openaiCatalog.models.map((model) => model.id), ['a']);
assert.equal(normalizeCatalogPayload({ weird: true }).shape, 'unknown');

// `generateContent` is necessary but not sufficient: Google serves images,
// speech, and music through the same method, so the exclusion patterns in
// config.json carry the rest. These are the real IDs the live listing returns.
{
  const patterns = JSON.parse(
    fs.readFileSync(new URL('config.json', import.meta.url), 'utf8'),
  ).discovery.exclude.modelPatterns.map((source) => new RegExp(source, 'i'));
  const excluded = (id) => patterns.some((pattern) => pattern.test(`gemini:${id}`));

  for (const id of [
    'gemini-2.5-flash-preview-tts',
    'gemini-3.1-flash-tts-preview',
    'gemini-3-pro-image',
    'gemini-3.1-flash-lite-image',
    'nano-banana-pro-preview',
    'lyria-3.5',
    'lyria-3-clip-preview',
    'gemini-3.5-transcribe',
    'gemini-robotics-er-2-preview',
    'gemini-2.5-computer-use-preview-10-2025',
    'deep-research-pro-preview-12-2025',
    'antigravity-preview-05-2026',
    // Moving aliases: they resolve to a concrete model that is ranked and
    // quota-tracked separately, so routing both double-counts one allowance.
    'gemini-flash-latest',
    'gemini-pro-latest',
  ]) {
    assert.equal(excluded(id), true, `should be excluded: ${id}`);
  }

  for (const id of [
    'gemini-3.8-flash',
    'gemini-3.5-flash-lite',
    'gemini-2.5-pro',
    'gemini-3.1-pro-preview',
    'gemma-4-31b-it',
    'gemini-omni-flash-preview',
  ]) {
    assert.equal(excluded(id), false, `should stay a candidate: ${id}`);
  }
}

// --- What a deploy platform detects, and config integrity -------------------
// SnapDeploy scans the repo and lists the variables it finds in `Dockerfile`,
// `.env.example`, and framework config. A scanner reads `NAME=value` pairs, so
// a commented-out name is invisible and the key never reaches the container.
{
  const repoRoot = path.dirname(fileURLToPath(import.meta.url));
  const shipped = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config.json'), 'utf8'));
  const envExample = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');

  const detected = new Set(
    envExample
      .split(/\r?\n/)
      .map((line) => line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/))
      .filter(Boolean)
      .map((match) => match[1]),
  );
  // A real value committed here is a leaked secret.
  const withValues = envExample.split(/\r?\n/).filter((line) => /^[A-Za-z_][A-Za-z0-9_]*=.+/.test(line));
  assert.deepEqual(withValues, [], '.env.example must not carry a real value');

  for (const [name, provider] of Object.entries(shipped.providers)) {
    const keyEnv = provider.keyEnv || `${name.replace(/-/g, '_').toUpperCase()}_API_KEY`;
    assert.ok(detected.has(keyEnv), `${keyEnv} is not detectable in .env.example`);
  }
  // The account id is interpolated into Cloudflare's base URL rather than sent
  // as a header, so it has to be discoverable too.
  assert.ok(detected.has('CLOUDFLARE_ACCOUNT_ID'), 'CLOUDFLARE_ACCOUNT_ID not in .env.example');

  // The provider table in the README is the only place a reader learns which
  // key to set, so it has to cover every provider in the config.
  const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
  const documented = new Set(
    [...readme.matchAll(/`([A-Z0-9_]+_API_KEY)`/g)].map((match) => match[1]),
  );
  for (const [name, provider] of Object.entries(shipped.providers)) {
    const keyEnv = provider.keyEnv || `${name.replace(/-/g, '_').toUpperCase()}_API_KEY`;
    assert.ok(documented.has(keyEnv), `${keyEnv} is undocumented in README.md`);
  }

  // A hand-edited route can name a provider that does not exist, which leaves
  // a dead entry in the ranking instead of an error.
  const route = shipped.routes['free-best'];
  assert.ok(route.length >= 40, `expected a populated route, got ${route.length}`);
  for (const entry of route) {
    const provider = typeof entry === 'string' ? shipped.defaultProvider : entry.provider;
    assert.ok(shipped.providers[provider], `route entry names unknown provider "${provider}"`);
    assert.ok(
      typeof entry === 'string' || entry.model,
      `route entry for ${provider} is missing a model`,
    );
  }
}

// --- Base URL environment interpolation ------------------------------------
// Cloudflare Workers AI scopes chat to /accounts/<account_id>/ai/v1, so the
// account id belongs in the URL. It comes from the environment to keep it out
// of the committed config.
{
  const template = {
    providers: {
      scoped: {
        baseUrl: 'https://example.test/accounts/${TEST_ACCOUNT_ID}/ai/v1',
        freeModels: ['m'],
      },
    },
  };

  delete process.env.TEST_ACCOUNT_ID;
  const unset = createProviderRegistry(template, { host: '127.0.0.1', port: 1 });
  // Unset expands to empty rather than throwing, so an unconfigured provider
  // fails its first request instead of blocking startup.
  assert.equal(unset.get('scoped').baseUrl, 'https://example.test/accounts//ai/v1');

  process.env.TEST_ACCOUNT_ID = 'acct-1';
  const set = createProviderRegistry(template, { host: '127.0.0.1', port: 1 });
  assert.equal(set.get('scoped').baseUrl, 'https://example.test/accounts/acct-1/ai/v1');
  assert.equal(
    set.chatUrl('scoped'),
    'https://example.test/accounts/acct-1/ai/v1/chat/completions',
  );
  delete process.env.TEST_ACCOUNT_ID;
}

// --- A keyless provider must not spend a catalog request --------------------
// The config lists many providers and most installs configure a few of them.
{
  let hits = 0;
  const catalogProbe = http.createServer((request, response) => {
    hits += 1;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'm', object: 'model' }] }));
  });
  await listen(catalogProbe);
  const catalogConfig = {
    providers: {
      keyless: {
        catalog: true,
        baseUrl: `http://127.0.0.1:${catalogProbe.address().port}/v1`,
        keyEnv: 'KEYLESS_API_KEY',
        freeModels: ['m'],
      },
    },
  };
  try {
    delete process.env.KEYLESS_API_KEY;
    const withoutKey = createProviderRegistry(catalogConfig, { host: '127.0.0.1', port: 1 });
    await withoutKey.refreshCatalogs(true, 0, () => {});
    assert.equal(hits, 0, 'a provider with no key must not fetch a catalog');

    process.env.KEYLESS_API_KEY = 'k';
    const withKey = createProviderRegistry(catalogConfig, { host: '127.0.0.1', port: 1 });
    await withKey.refreshCatalogs(true, 0, () => {});
    assert.equal(hits, 1, 'a configured provider should still fetch its catalog');
    assert.equal(withKey.get('keyless').catalog.size, 1);
    delete process.env.KEYLESS_API_KEY;
  } finally {
    await close(catalogProbe);
  }
}

// --- Catalog refresh is concurrent but bounded -----------------------------
// handleChat awaits this, so a serial loop over every configured provider put
// the first request behind all of them at once.
{
  let inFlight = 0;
  let peak = 0;
  let served = 0;
  const slowCatalog = http.createServer((request, response) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    setTimeout(() => {
      inFlight -= 1;
      served += 1;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'm', object: 'model' }] }));
    }, 250);
  });
  await listen(slowCatalog);
  const slowPort = slowCatalog.address().port;
  const many = { providers: {} };
  for (let index = 0; index < 12; index += 1) {
    const name = `slow${index}`;
    many.providers[name] = {
      catalog: true,
      baseUrl: `http://127.0.0.1:${slowPort}/v${index}`,
      keyEnv: `SLOW${index}_API_KEY`,
      freeModels: ['m'],
    };
    process.env[`SLOW${index}_API_KEY`] = 'k';
  }
  try {
    const started = Date.now();
    const manyRegistry = createProviderRegistry(many, { host: '127.0.0.1', port: 1 });
    await manyRegistry.refreshCatalogs(true, 0, () => {});
    const elapsed = Date.now() - started;

    assert.equal(served, 12, 'every provider catalog should still be fetched');
    assert.equal(
      [...manyRegistry.providers.values()].filter((provider) => provider.catalog.size === 1)
        .length,
      12,
      'every catalog should be populated',
    );
    assert.ok(peak > 1, `refresh should overlap, peak was ${peak}`);
    assert.ok(peak <= 6, `refresh should stay bounded, peak was ${peak}`);
    // 12 providers at 250ms is 3s serial and about 500ms at concurrency 6.
    assert.ok(elapsed < 2000, `refresh took ${elapsed}ms; serial would be ~3000ms`);
  } finally {
    for (let index = 0; index < 12; index += 1) delete process.env[`SLOW${index}_API_KEY`];
    await close(slowCatalog);
  }
}

// Shared by the spawned-server tests below. Declared here rather than reusing
// the module's HERE, which is a const further down and still in its TDZ.
const serverEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), 'server.mjs');

// --- The platform-assigned PORT is honoured --------------------------------
// SnapDeploy assigns the port, injects it as PORT, and locks it.
{
  const portProbe = http.createServer();
  await listen(portProbe);
  const assignedPort = portProbe.address().port;
  await close(portProbe);

  const portDir = fs.mkdtempSync(path.join(os.tmpdir(), 'free-router-port-'));
  const portConfig = path.join(portDir, 'config.json');
  fs.writeFileSync(
    portConfig,
    JSON.stringify({
      host: '127.0.0.1',
      // Deliberately not the assigned port: PORT has to win.
      port: 1,
      ui: { enabled: false },
      discovery: { enabled: false },
      providers: {
        openrouter: {
          catalog: true,
          pricing: true,
          baseUrl: 'http://127.0.0.1:1/api/v1',
          keyEnv: 'OPENROUTER_API_KEY',
        },
      },
    }),
  );

  const portChild = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      FREE_ROUTER_CONFIG: portConfig,
      FREE_ROUTER_PORT: '',
      PORT: String(assignedPort),
      OPENROUTER_API_KEY: 'test-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  // The exit listener has to be attached before anything awaits: a server that
  // fails to bind exits immediately, and listening afterwards never fires,
  // which would turn a real failure into an unsettled await.
  let exitInfo = null;
  let portChildOutput = '';
  portChild.stdout.on('data', (chunk) => {
    portChildOutput += chunk;
  });
  portChild.stderr.on('data', (chunk) => {
    portChildOutput += chunk;
  });
  const portChildExited = new Promise((resolve) => {
    portChild.once('exit', (code, signal) => {
      exitInfo = { code, signal };
      resolve();
    });
  });

  try {
    let answered = false;
    for (let attempt = 0; attempt < 80 && !exitInfo; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${assignedPort}/health`);
        if (response.ok) {
          answered = true;
          break;
        }
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(
      answered,
      exitInfo
        ? `server exited instead of listening on PORT ${assignedPort} ` +
            `(code ${exitInfo.code}, signal ${exitInfo.signal}): ${portChildOutput.slice(-400)}`
        : `server did not answer on the platform-assigned PORT ${assignedPort}`,
    );
  } finally {
    if (!exitInfo) portChild.kill('SIGKILL');
    await portChildExited;
    fs.rmSync(portDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

// --- FREE_ROUTER_API_KEY guards the API surface ----------------------------
// A container bound to 0.0.0.0 otherwise publishes the provider layout on
// /health and spends the operator's quota through /v1/chat/completions.
{
  const authProbe = http.createServer();
  await listen(authProbe);
  const authPort = authProbe.address().port;
  await close(authProbe);

  const authDir = fs.mkdtempSync(path.join(os.tmpdir(), 'free-router-auth-'));
  const authConfig = path.join(authDir, 'config.json');
  fs.writeFileSync(
    authConfig,
    JSON.stringify({
      host: '127.0.0.1',
      port: authPort,
      ui: { enabled: true },
      discovery: { enabled: false },
      providers: {
        openrouter: {
          catalog: true,
          pricing: true,
          baseUrl: 'http://127.0.0.1:1/api/v1',
          keyEnv: 'OPENROUTER_API_KEY',
        },
      },
    }),
  );

  const authChild = spawn(process.execPath, [serverEntry], {
    env: {
      ...process.env,
      FREE_ROUTER_CONFIG: authConfig,
      PORT: String(authPort),
      FREE_ROUTER_API_KEY: 'test-shared-secret',
      OPENROUTER_API_KEY: 'test-key',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let authExitInfo = null;
  const authExited = new Promise((resolve) => {
    authChild.once('exit', (code, signal) => {
      authExitInfo = { code, signal };
      resolve();
    });
  });

  try {
    let ready = false;
    for (let attempt = 0; attempt < 80 && !authExitInfo; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${authPort}/health`, {
          headers: { Authorization: 'Bearer test-shared-secret' },
        });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // Not listening yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'server did not come up for the authentication test');

    const statusOf = async (target, token) => {
      const response = await fetch(`http://127.0.0.1:${authPort}${target}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      return response.status;
    };

    assert.equal(await statusOf('/health'), 401, '/health must require the token');
    assert.equal(await statusOf('/health', 'wrong'), 401, 'a wrong token must be rejected');
    assert.equal(await statusOf('/health', 'test-shared-secret'), 200);
    assert.equal(await statusOf('/v1/models'), 401, '/v1/models must require the token');
    assert.equal(await statusOf('/v1/models', 'test-shared-secret'), 200);
    // The dashboard stays reachable for an authenticated caller, which is what
    // makes a deployed instance manageable from outside loopback.
    assert.equal(await statusOf('/', 'test-shared-secret'), 200);

    const chat = await fetch(`http://127.0.0.1:${authPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'free-best', messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(chat.status, 401, '/v1/chat/completions must require the token');
  } finally {
    if (!authExitInfo) authChild.kill('SIGKILL');
    await authExited;
    fs.rmSync(authDir, { recursive: true, force: true, maxRetries: 3 });
  }
}

// Verbatim from a live 429 for gemini-3.1-pro-preview on a free-tier key.
const noFreeTierBody = {
  error: {
    code: 429,
    message:
      'You exceeded your current quota, please check your plan and billing details. ' +
      '\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro' +
      '\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3.1-pro' +
      '\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3.1-pro' +
      '\n* Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, limit: 0, model: gemini-3.1-pro' +
      '\nPlease retry in 56.713473252s.',
    status: 'RESOURCE_EXHAUSTED',
    details: [
      { '@type': 'type.googleapis.com/google.rpc.Help', links: [] },
      {
        '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
        violations: [
          {
            quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
            quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier',
          },
          {
            quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests',
            quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier',
          },
          {
            quotaMetric:
              'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count',
            quotaId: 'GenerateContentInputTokensPerModelPerMinute-FreeTier',
          },
          {
            quotaMetric:
              'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count',
            quotaId: 'GenerateContentInputTokensPerModelPerDay-FreeTier',
          },
        ],
      },
      { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '56.713473252s' },
    ],
  },
};
const noFreeTier = parseQuotaFailure(noFreeTierBody);
assert.equal(noFreeTier.noFreeTier, true);
assert.equal(noFreeTier.dailyRequestLimit, null);
assert.equal(noFreeTier.exhaustedWindow, '');
assert.equal(noFreeTier.retryDelayMs, 56714);
// The per-day requests allowance is paired with its window, not just its number.
assert.equal(
  noFreeTier.limits.find((entry) => entry.quotaId.startsWith('GenerateRequestsPerDay')).window,
  'day',
);

// Same shape, but the allowance exists and is merely spent: this must not be
// mistaken for a model that has no free tier.
const exhaustedBody = structuredClone(noFreeTierBody);
exhaustedBody.error.message = exhaustedBody.error.message
  .replace(/generate_content_free_tier_requests, limit: 0/g, 'generate_content_free_tier_requests, limit: 20')
  .replace(
    /generate_content_free_tier_input_token_count, limit: 0/g,
    'generate_content_free_tier_input_token_count, limit: 1000000',
  );
const exhausted = parseQuotaFailure(exhaustedBody);
assert.equal(exhausted.noFreeTier, false);
assert.equal(exhausted.dailyRequestLimit, 20);
assert.equal(exhausted.exhaustedWindow, 'day');

// The decisive case: one free-tier allowance is spent while another reads
// zero. Only a model with no nonzero allowance anywhere lacks a free tier, so
// treating "any zero" as proof would permanently drop a working model.
const mixedBody = structuredClone(noFreeTierBody);
mixedBody.error.message = mixedBody.error.message.replace(
  /generate_content_free_tier_requests, limit: 0/g,
  'generate_content_free_tier_requests, limit: 20',
);
const mixed = parseQuotaFailure(mixedBody);
assert.equal(mixed.noFreeTier, false);
assert.equal(mixed.dailyRequestLimit, 20);

assert.equal(parseQuotaFailure({ error: { message: 'nothing to do with quota' } }), null);

assert.match(
  permanentRejection(404, {
    error: { message: 'This model models/gemini-2.5-pro is no longer available to new users.' },
  }),
  /withdrawn/,
);
assert.match(permanentRejection(404, {}), /not served here/);
assert.match(
  permanentRejection(400, { error: { message: 'This model only supports Interactions API.' } }),
  /not a chat/,
);
assert.equal(permanentRejection(429, { error: { message: 'quota' } }), '');

// A daily quota resets at Pacific midnight, so the wait is until that boundary
// rather than a fixed interval. In September that is UTC-7, and the result
// carries a one minute cushion so the retry lands past the boundary.
const minute = 60000;
// 23:50 Pacific: ten minutes left in the quota day.
assert.equal(msUntilQuotaReset(Date.parse('2026-09-08T06:50:00Z')), 11 * minute);
// 01:05 Pacific: almost a full day to wait, and notably not a fixed 10 minutes.
assert.equal(msUntilQuotaReset(Date.parse('2026-09-08T08:05:00Z')), (22 * 60 + 56) * minute);

// Paths shown in the interface or the log must not carry the username.
assert.equal(displayPath(path.join(os.homedir(), 'free-router', '.env')), '~/free-router/.env');
assert.equal(displayPath(os.homedir()), '~');
assert.equal(displayPath('/etc/free-router/.env'), '/etc/free-router/.env');
assert.equal(displayPath(''), '');

assert.equal(maskSecret('').length, 0);
assert.equal(maskSecret('short'), '***** (5)');
assert.equal(maskSecret('sk-or-v1-0123456789abcdef'), 'sk-or********cdef (25)');
assert.equal(maskSecret('sk-or-v1-0123456789abcdef').includes('0123456789'), false);
assert.match(validateSecret('ok\nNODE_OPTIONS=x'), /newline/);
assert.equal(validateSecret('sk-normal-key'), '');

assert.equal(providerNeedsThoughtSignatures({ name: 'gemini', baseUrl: 'http://127.0.0.1' }), true);
assert.equal(
  providerNeedsThoughtSignatures({
    name: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  }),
  true,
);
assert.equal(providerNeedsThoughtSignatures({ name: 'bai', baseUrl: 'https://api.b.ai/v1' }), false);
assert.equal(
  isMissingThoughtSignatureError(
    400,
    'Function call is missing a thought_signature in functionCall parts',
  ),
  true,
);
assert.equal(isMissingThoughtSignatureError(400, 'bad request'), false);
assert.equal(isMissingThoughtSignatureError(429, 'thought_signature'), false);

{
  const cache = createThoughtSignatureCache(2);
  cache.remember('a', 'sig-a');
  cache.remember('b', 'sig-b');
  cache.remember('c', 'sig-c');
  assert.equal(cache.lookup('a'), '');
  assert.equal(cache.lookup('c'), 'sig-c');
  const body = {
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        tool_calls: [
          {
            id: 'call_keep',
            type: 'function',
            function: { name: 'search_files', arguments: '{}' },
            extra_content: { google: { thought_signature: 'KEEP' } },
          },
          {
            id: 'call_cached',
            type: 'function',
            function: { name: 'terminal', arguments: '{}' },
          },
          {
            id: 'call_skip',
            type: 'function',
            function: { name: 'other', arguments: '{}' },
          },
        ],
      },
    ],
  };
  cache.remember('call_cached', 'CACHED');
  injectThoughtSignatures(body, cache);
  assert.equal(readThoughtSignature(body.messages[1].tool_calls[0]), 'KEEP');
  assert.equal(readThoughtSignature(body.messages[1].tool_calls[1]), 'CACHED');
  assert.equal(readThoughtSignature(body.messages[1].tool_calls[2]), SKIP_THOUGHT_SIGNATURE);
}

{
  const cache = createThoughtSignatureCache();
  rememberSignaturesFromPayload(
    {
      choices: [
        {
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call_json',
                extra_content: { google: { thoughtSignature: 'JSON-SIG' } },
              },
            ],
          },
        },
      ],
    },
    cache,
  );
  assert.equal(cache.lookup('call_json'), 'JSON-SIG');
  const streamCache = createThoughtSignatureCache();
  const extractor = createStreamSignatureExtractor((id, signature) => {
    streamCache.remember(id, signature);
  });
  extractor.push(
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"search_files","arguments":"{}"}}]}}]}\n',
  );
  extractor.push(
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"extra_content":{"google":{"thought_signature":"STREAM-SIG"}}}]}}]}\n\n',
  );
  extractor.flush();
  assert.equal(streamCache.lookup('call_1'), 'STREAM-SIG');
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

const mock = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/v1/models') {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        data: [
          'mock-a',
          'mock-b',
          'mock-new',
          'mock-audio',
          'acme/extra-1:free',
          'mock-domain',
        ].map((id) => ({
          id,
          description:
            id === 'mock-domain'
              ? 'A finance-focused mixture-of-experts model for investment research.'
              : 'A general purpose text model.',
          pricing:
            id === 'mock-b'
              ? { prompt: '0.000001', completion: '0.000001' }
              : { prompt: '0', completion: '0' },
          supported_parameters: ['tools', 'response_format'],
          architecture: {
            input_modalities: ['text'],
            output_modalities: id === 'mock-audio' ? ['text', 'audio'] : ['text'],
          },
        })),
      }),
    );
    return;
  }
  if (req.method === 'POST' && req.url === '/api/v1/chat/completions') {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const isEvaluation = body.messages?.some(
      (message) => typeof message.content === 'string' && message.content.includes('OX-RANK-7'),
    );
    if (isEvaluation) {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          model: body.model,
          choices: [
            {
              message: {
                role: 'assistant',
                content: JSON.stringify({
                  token: 'OX-RANK-7',
                  crt: 269,
                  trace: '1-3',
                  path: 10,
                  sequence: 42,
                  binary: 55,
                  derange: 44,
                  recur: 26,
                  modpow: 49,
                }),
              },
              finish_reason: 'stop',
            },
          ],
        }),
      );
      return;
    }
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (body.model === 'mock-a') {
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: { reasoning: 'thinking only' }, finish_reason: null }],
          })}\n\n`,
        );
        res.write(
          `data: ${JSON.stringify({
            choices: [{ delta: {}, finish_reason: 'stop' }],
          })}\n\n`,
        );
      } else {
        res.write(
          `data: ${JSON.stringify({
            model: 'mock-b',
            choices: [{ delta: { content: 'router-ok' }, finish_reason: null }],
          })}\n\n`,
        );
      }
      res.end('data: [DONE]\n\n');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        model: body.model,
        choices: [
          {
            message:
              body.model === 'mock-a'
                ? { role: 'assistant', content: '', reasoning: 'thinking only' }
                : { role: 'assistant', content: 'router-ok' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

let tokenRouterRequests = 0;
const tokenRouterMock = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/api/v1/chat/completions') {
    tokenRouterRequests += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const shouldFail = body.messages?.some(
      (message) => message.content === 'force-token-failure',
    );
    if (shouldFail) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'tokenrouter rate limited' } }));
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        model: 'glm-5.3',
        choices: [
          {
            message: { role: 'assistant', content: 'tokenrouter-ok' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

let baiRequests = 0;
let lastBaiBody = null;
let lastBaiAuth = '';
const baiMock = http.createServer(async (req, res) => {
  // A price-free catalog, in the shape Gemini's OpenAI-compat endpoint returns:
  // ids carry a "models/" prefix and glm-withdrawn is simply absent.
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        object: 'list',
        data: [
          { id: 'models/glm-5.3-flash', object: 'model', owned_by: 'bai' },
          // Not in freeModels, so these three are probe candidates: one is
          // served, one has no free allowance, one is not a chat model at all.
          { id: 'models/glm-5.3-pro', object: 'model', owned_by: 'bai' },
          { id: 'models/glm-5.3-paid', object: 'model', owned_by: 'bai' },
          {
            id: 'models/glm-5.3-embed',
            object: 'model',
            architecture: { output_modalities: ['embedding'] },
          },
        ],
      }),
    );
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    baiRequests += 1;
    lastBaiAuth = req.headers.authorization || '';
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    lastBaiBody = body;
    // Probes address a model by the id the catalog published, prefix included.
    if (normalizeModelSlug(body.model) === 'glm-5.3-paid') {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      // Wrapped in an array, the way Gemini's OpenAI-compatible layer returns
      // errors. Read as an object, `error.message` is missing and the whole
      // reason for the refusal is lost.
      res.end(JSON.stringify([quotaRejection(0)]));
      return;
    }
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          model: body.model,
          choices: [{ delta: { content: 'bai-ok' }, finish_reason: null }],
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        model: body.model,
        choices: [
          {
            message: { role: 'assistant', content: 'bai-ok' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

let extraRequests = 0;
const extraMock = http.createServer(async (req, res) => {
  // A catalog that cannot be fetched must not empty the route: freeModels stays
  // authoritative and availability checking is simply skipped.
  if (req.method === 'GET' && req.url === '/v1/models') {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'catalog unavailable' } }));
    return;
  }
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    extraRequests += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const shouldFail = body.messages?.some(
      (message) => message.content === 'force-extra-failure',
    );
    if (shouldFail) {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'extra rate limited' } }));
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        model: body.model,
        choices: [
          {
            message: { role: 'assistant', content: 'extra-ok' },
            finish_reason: 'stop',
          },
        ],
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

let geminiRequests = 0;
let lastGeminiBody = null;
const geminiMock = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/v1beta/openai/chat/completions') {
    geminiRequests += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    lastGeminiBody = body;
    const forceMissing = body.messages?.some(
      (message) => message.content === 'force-thought-signature-400',
    );
    const missingSignature = (body.messages || []).some(
      (message) =>
        Array.isArray(message.tool_calls) &&
        message.tool_calls.some((call) => !readThoughtSignature(call)),
    );
    if (forceMissing || missingSignature) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify([
          {
            error: {
              code: 400,
              message:
                'Function call is missing a thought_signature in functionCall parts. https://ai.google.dev/gemini-api/docs/thought-signatures',
            },
          },
        ]),
      );
      return;
    }
    if (body.stream && body.messages?.some((message) => message.content === 'need-tools-stream')) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          model: body.model,
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_stream',
                    type: 'function',
                    function: { name: 'search_files', arguments: '{}' },
                  },
                ],
              },
            },
          ],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          model: body.model,
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    extra_content: { google: { thought_signature: 'STREAM-SIG' } },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        })}\n\n`,
      );
      res.end('data: [DONE]\n\n');
      return;
    }
    if (body.messages?.some((message) => message.content === 'need-tools-json')) {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          model: body.model,
          choices: [
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'call_json',
                    type: 'function',
                    function: { name: 'search_files', arguments: '{}' },
                    extra_content: { google: { thought_signature: 'JSON-SIG' } },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      );
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        model: body.model,
        choices: [{ message: { role: 'assistant', content: 'gemini-ok' }, finish_reason: 'stop' }],
      }),
    );
    return;
  }
  res.writeHead(404).end();
});

// Mimics Gemini's quota rejection so the two meanings of 429 can be told apart
// end to end: no free allowance at all, versus today's allowance spent.
function quotaRejection(limit) {
  const metric = (suffix) => `generativelanguage.googleapis.com/generate_content_${suffix}`;
  const lines = [
    `${metric('free_tier_requests')}, limit: ${limit}`,
    `${metric('free_tier_requests')}, limit: ${limit}`,
    `${metric('free_tier_input_token_count')}, limit: ${limit === 0 ? 0 : 1000000}`,
    `${metric('free_tier_input_token_count')}, limit: ${limit === 0 ? 0 : 1000000}`,
  ].map((line) => `* Quota exceeded for metric: ${line}, model: mock`);
  return {
    error: {
      code: 429,
      status: 'RESOURCE_EXHAUSTED',
      message: `You exceeded your current quota.\n${lines.join('\n')}\nPlease retry in 42.5s.`,
      details: [
        {
          '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
          violations: [
            ['free_tier_requests', 'GenerateRequestsPerDayPerProjectPerModel-FreeTier'],
            ['free_tier_requests', 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier'],
            ['free_tier_input_token_count', 'GenerateContentInputTokensPerModelPerMinute-FreeTier'],
            ['free_tier_input_token_count', 'GenerateContentInputTokensPerModelPerDay-FreeTier'],
          ].map(([suffix, quotaId]) => ({ quotaMetric: metric(suffix), quotaId })),
        },
        { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '42.5s' },
      ],
    },
  };
}

let quotaRequests = 0;
const quotaMock = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    quotaRequests += 1;
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const model = JSON.parse(Buffer.concat(chunks).toString('utf8')).model;
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(quotaRejection(model === 'no-free-tier' ? 0 : 20)));
    return;
  }
  res.writeHead(404).end();
});

await listen(mock);
const mockPort = mock.address().port;
await listen(quotaMock);
const quotaPort = quotaMock.address().port;
await listen(tokenRouterMock);
const tokenRouterPort = tokenRouterMock.address().port;
await listen(baiMock);
const baiPort = baiMock.address().port;
await listen(extraMock);
const extraPort = extraMock.address().port;
await listen(geminiMock);
const geminiPort = geminiMock.address().port;

const portProbe = http.createServer();
await listen(portProbe);
const routerPort = portProbe.address().port;
await close(portProbe);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'free-router-test-'));
const testConfig = path.join(tempDir, 'config.json');
fs.writeFileSync(
  testConfig,
  JSON.stringify({
    host: '127.0.0.1',
    port: routerPort,
    attemptTimeoutMs: 5000,
    catalogRefreshMs: 1000,
    defaultProvider: 'openrouter',
    providers: {
      openrouter: {
        catalog: true,
        pricing: true,
        baseUrl: `http://127.0.0.1:${mockPort}/api/v1`,
        keyEnv: 'OPENROUTER_API_KEY',
      },
      tokenrouter: {
        baseUrl: `http://127.0.0.1:${tokenRouterPort}/api/v1`,
        keyEnv: 'TOKENROUTER_API_KEY',
        freeModels: ['z-ai/glm-5.3-free'],
      },
      bai: {
        catalog: true,
        pricing: false,
        probeFreeTier: true,
        baseUrl: `http://127.0.0.1:${baiPort}/v1`,
        keyEnv: 'BAI_API_KEY',
        freeModels: ['glm-5.3-flash', 'glm-withdrawn'],
      },
      extra: {
        catalog: true,
        pricing: false,
        baseUrl: `http://127.0.0.1:${extraPort}/v1`,
        keyEnv: 'EXTRA_API_KEY',
        freeModels: ['extra-1'],
      },
      gemini: {
        baseUrl: `http://127.0.0.1:${geminiPort}/v1beta/openai`,
        keyEnv: 'GEMINI_API_KEY',
        freeModels: ['gemini-3.8-flash', 'gemini-3.7-flash'],
      },
      // No dailyLimits entry anywhere in this config: the limit for
      // daily-exhausted has to be learned from the provider's own 429.
      quotamock: {
        baseUrl: `http://127.0.0.1:${quotaPort}/v1`,
        keyEnv: 'QUOTAMOCK_API_KEY',
        freeModels: ['no-free-tier', 'daily-exhausted'],
      },
    },
    discovery: {
      enabled: true,
      provider: 'openrouter',
      intervalMs: 604800000,
      route: 'test-route',
      stateFile: 'discovered-free-models.json',
      exclude: {
        textPatterns: ['\\b(finance|medicine)[\\s-]*focused\\b'],
      },
      evaluation: {
        enabled: true,
        pinnedModels: ['tokenrouter:z-ai/glm-5.3-free', 'bai:glm-5.3-flash'],
        baselineScores: { 'mock-b': 80 },
        usageWeight: 12,
        usageMinRequests: 2,
      },
    },
    cooldownMs: {},
    usage: {
      retentionDays: 3,
      timezone: 'UTC',
      dailyLimits: { 'bai:glm-5.3-flash': 5, 'tokenrouter:*': 50 },
    },
    routes: {
      'test-route': [
        { provider: 'tokenrouter', model: 'z-ai/glm-5.3-free' },
        { provider: 'bai', model: 'glm-5.3-flash' },
        'mock-a',
        'mock-b',
        { provider: 'extra', model: 'extra-1' },
        { provider: 'bai', model: 'glm-withdrawn' },
        { provider: 'quotamock', model: 'no-free-tier' },
        { provider: 'quotamock', model: 'daily-exhausted' },
      ],
      'tool-fallback': [
        { provider: 'gemini', model: 'gemini-3.8-flash' },
        { provider: 'gemini', model: 'gemini-3.7-flash' },
      ],
    },
  }),
);

const child = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
  env: {
    ...process.env,
    OPENROUTER_API_KEY: 'test-key',
    OPENROUTER_BASE_URL: `http://127.0.0.1:${mockPort}/api/v1`,
    TOKENROUTER_API_KEY: 'token-test-key',
    TOKENROUTER_BASE_URL: `http://127.0.0.1:${tokenRouterPort}/api/v1`,
    BAI_API_KEY: 'bai-test-key',
    BAI_BASE_URL: `http://127.0.0.1:${baiPort}/v1`,
    EXTRA_API_KEY: 'extra-test-key',
    EXTRA_BASE_URL: `http://127.0.0.1:${extraPort}/v1`,
    GEMINI_API_KEY: 'gemini-test-key',
    GEMINI_BASE_URL: `http://127.0.0.1:${geminiPort}/v1beta/openai`,
    QUOTAMOCK_API_KEY: 'quota-test-key',
    QUOTAMOCK_BASE_URL: `http://127.0.0.1:${quotaPort}/v1`,
    FREE_ROUTER_CONFIG: testConfig,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let childOutput = '';
child.stdout.on('data', (chunk) => {
  childOutput += chunk;
});
child.stderr.on('data', (chunk) => {
  childOutput += chunk;
});

async function waitForHealth() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${routerPort}/health`);
      if (response.ok) {
        const health = await response.json();
        if (health.discovery?.lastCheckedAt) return health;
      }
    } catch {
      // Service is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`router did not start\n${childOutput}`);
}

try {
  const health = await waitForHealth();
  assert.equal(health.version, PACKAGE_VERSION);
  // mock-new came from the priced catalog; glm-5.3-pro came from asking bai to
  // serve a model its price-free catalog says nothing about.
  assert.deepEqual(health.discovery.addedModels, ['mock-new', 'bai:models/glm-5.3-pro']);

  const probeVerdicts = health.discovery.modelVerdicts;
  assert.equal(probeVerdicts['bai:models/glm-5.3-pro'].free, true);
  assert.match(probeVerdicts['bai:models/glm-5.3-pro'].reason, /served a free-tier request/);
  // Answered 429 with every free-tier limit at zero, so it never enters a route.
  assert.equal(probeVerdicts['bai:models/glm-5.3-paid'].free, false);
  assert.equal(
    health.routes['test-route'].some((entry) => entry.id.includes('glm-5.3-paid')),
    false,
  );
  // Not a chat model, so it was filtered out before any request was spent on it.
  assert.equal(probeVerdicts['bai:models/glm-5.3-embed'], undefined);
  // Already configured under a bare id, so the prefixed catalog entry for the
  // same model must not be probed again or added a second time.
  assert.equal(probeVerdicts['bai:models/glm-5.3-flash'], undefined);
  assert.equal(
    health.routes['test-route'].filter((entry) => entry.id.includes('glm-5.3-flash')).length,
    1,
  );
  // A domain-tuned model is free and chat-capable, but must not be auto-routed
  // or spend an evaluation on it.
  assert.deepEqual(health.discovery.excludedModels, ['mock-domain']);
  assert.equal(health.discovery.evaluations['mock-domain'], undefined);
  assert.equal(
    health.routes['test-route'].some((entry) => entry.id === 'mock-domain'),
    false,
  );
  // mock-new aces the benchmark but the low latency weight no longer lets it
  // leapfrog mock-a, whose configured anchor score is 90. The quotamock pair
  // is still present here: nothing has asked them anything yet.
  assert.deepEqual(
    health.routes['test-route'].map((entry) => `${entry.provider}:${entry.id}`),
    [
      'tokenrouter:z-ai/glm-5.3-free',
      'bai:glm-5.3-flash',
      'openrouter:mock-a',
      'openrouter:mock-new',
      'extra:extra-1',
      'openrouter:acme/extra-1:free',
      'quotamock:no-free-tier',
      'quotamock:daily-exhausted',
      'bai:models/glm-5.3-pro',
    ],
  );
  const mockNewEvaluation = health.discovery.evaluations['mock-new'];
  assert.equal(mockNewEvaluation.version, 2);
  assert.equal(mockNewEvaluation.benchmarkScore, 65);
  assert.equal(mockNewEvaluation.metadataScore, 12);
  assert.equal(mockNewEvaluation.latencyScore, 6);
  assert.equal(mockNewEvaluation.score, 83);
  assert.equal(health.defaultProvider, 'openrouter');
  assert.equal(health.discovery.provider, 'openrouter');
  assert.equal(health.providers.openrouter.kind, 'catalog');
  assert.equal(health.providers.tokenrouter.kind, 'static');
  assert.equal(health.providers.extra.configured, true);

  // Only a provider that publishes prices may contribute new models; the others
  // consult their catalog purely to notice withdrawals.
  assert.deepEqual(health.discovery.addsFrom, ['openrouter']);
  assert.deepEqual(health.discovery.availabilityOnly, ['bai', 'extra']);
  assert.equal(health.providers.bai.kind, 'static+catalog');

  // glm-5.3-flash is listed upstream as "models/glm-5.3-flash": a spelling
  // difference must not read as a withdrawal.
  assert.deepEqual(health.providers.bai.unavailableModels, ['glm-withdrawn']);
  assert.deepEqual(health.discovery.unavailableModels, ['bai:glm-withdrawn']);
  assert.equal(
    health.routes['test-route'].some((entry) => entry.id === 'glm-withdrawn'),
    false,
  );
  // An allowlisted model is free by configuration, so a catalog without prices
  // must not make it look paid.
  assert.equal(
    health.routes['test-route'].find((entry) => entry.id === 'glm-5.3-flash').zeroCost,
    true,
  );
  // extra's catalog request fails, which must leave its allowlist authoritative
  // instead of dropping the provider from the route.
  assert.equal(health.providers.extra.kind, 'static+catalog');
  assert.deepEqual(health.providers.extra.unavailableModels, []);
  assert.equal(
    health.routes['test-route'].some((entry) => entry.id === 'extra-1'),
    true,
  );
  assert.ok(health.providers.extra.catalogError);
  assert.deepEqual(health.discovery.removedModels, ['mock-b']);
  assert.equal(health.discovery.evaluations['mock-new'].status, 'scored');
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(tempDir, 'discovered-free-models.json'), 'utf8'))
      .addedModels[0],
    'mock-new',
  );
  const modelsResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/models`);
  assert.equal(modelsResponse.status, 200);
  const models = await modelsResponse.json();
  // Exclusion only removes a model from automatic ranking. It stays listed and
  // callable by explicit ID, since asking for it by name is a deliberate choice.
  assert.deepEqual(
    models.data.map((model) => model.id),
    [
      'test-route',
      'tool-fallback',
      'z-ai/glm-5.3-free',
      'glm-5.3-flash',
      'extra-1',
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'no-free-tier',
      'daily-exhausted',
      'acme/extra-1:free',
      'mock-a',
      'mock-domain',
      'mock-new',
    ],
  );
  const request = {
    model: 'test-route',
    messages: [{ role: 'user', content: 'force-token-failure' }],
  };

  const jsonResponse = await fetch(
    `http://127.0.0.1:${routerPort}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    },
  );
  assert.equal(jsonResponse.status, 200);
  assert.equal(jsonResponse.headers.get('x-free-router-provider'), 'bai');
  assert.equal(jsonResponse.headers.get('x-free-router-model'), 'glm-5.3-flash');
  const json = await jsonResponse.json();
  assert.equal(json.model, 'glm-5.3-flash');
  assert.equal(json.choices[0].message.content, 'bai-ok');

  const streamResponse = await fetch(
    `http://127.0.0.1:${routerPort}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...request, stream: true }),
    },
  );
  assert.equal(streamResponse.status, 200);
  assert.equal(streamResponse.headers.get('x-free-router-provider'), 'bai');
  assert.equal(streamResponse.headers.get('x-free-router-model'), 'glm-5.3-flash');
  const stream = await streamResponse.text();
  assert.match(stream, /bai-ok/);
  assert.doesNotMatch(stream, /thinking only/);

  const directTokenRouterResponse = await fetch(
    `http://127.0.0.1:${routerPort}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'z-ai/glm-5.3-free',
        messages: [{ role: 'user', content: 'token-success' }],
      }),
    },
  );
  assert.equal(directTokenRouterResponse.status, 200);
  assert.equal(
    directTokenRouterResponse.headers.get('x-free-router-provider'),
    'tokenrouter',
  );
  assert.equal(
    (await directTokenRouterResponse.json()).choices[0].message.content,
    'tokenrouter-ok',
  );

  const updatedHealth = await fetch(`http://127.0.0.1:${routerPort}/health`).then((res) =>
    res.json(),
  );
  assert.equal(updatedHealth.lastSelection.route, 'z-ai/glm-5.3-free');
  assert.equal(updatedHealth.lastSelection.provider, 'tokenrouter');
  assert.equal(updatedHealth.lastSelection.model, 'z-ai/glm-5.3-free');
  const directBaiResponse = await fetch(
    `http://127.0.0.1:${routerPort}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'glm-5.3-flash',
        messages: [{ role: 'user', content: 'bai-success' }],
      }),
    },
  );
  assert.equal(directBaiResponse.status, 200);
  assert.equal(directBaiResponse.headers.get('x-free-router-provider'), 'bai');
  assert.equal((await directBaiResponse.json()).choices[0].message.content, 'bai-ok');

  const afterBaiHealth = await fetch(`http://127.0.0.1:${routerPort}/health`).then((res) =>
    res.json(),
  );
  assert.equal(afterBaiHealth.lastSelection.provider, 'bai');
  assert.equal(afterBaiHealth.lastSelection.model, 'glm-5.3-flash');

  const directExtraResponse = await fetch(
    `http://127.0.0.1:${routerPort}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'extra-1',
        messages: [{ role: 'user', content: 'extra-success' }],
      }),
    },
  );
  assert.equal(directExtraResponse.status, 200);
  assert.equal(directExtraResponse.headers.get('x-free-router-provider'), 'extra');
  assert.equal((await directExtraResponse.json()).choices[0].message.content, 'extra-ok');
  assert.ok(extraRequests >= 1);

  const extraFailoverResponse = await fetch(
    `http://127.0.0.1:${routerPort}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'extra-1',
        messages: [{ role: 'user', content: 'force-extra-failure' }],
      }),
    },
  );
  assert.equal(extraFailoverResponse.status, 200);
  assert.equal(extraFailoverResponse.headers.get('x-free-router-provider'), 'openrouter');
  assert.equal(extraFailoverResponse.headers.get('x-free-router-model'), 'acme/extra-1:free');
  assert.equal(
    (await extraFailoverResponse.json()).choices[0].message.content,
    'router-ok',
  );

  const geminiSkipResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini:gemini-3.8-flash',
      messages: [
        { role: 'user', content: 'search' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_unseen',
              type: 'function',
              function: { name: 'search_files', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_unseen', content: 'found' },
      ],
    }),
  });
  assert.equal(geminiSkipResponse.status, 200);
  assert.equal(readThoughtSignature(lastGeminiBody.messages[1].tool_calls[0]), SKIP_THOUGHT_SIGNATURE);

  const geminiToolResponse = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini:gemini-3.8-flash',
      messages: [{ role: 'user', content: 'need-tools-json' }],
    }),
  });
  assert.equal(geminiToolResponse.status, 200);
  const geminiTools = await geminiToolResponse.json();
  const jsonToolCall = geminiTools.choices[0].message.tool_calls[0];
  assert.equal(readThoughtSignature(jsonToolCall), 'JSON-SIG');
  const geminiReplay = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini:gemini-3.8-flash',
      messages: [
        { role: 'user', content: 'need-tools-json' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: jsonToolCall.id,
              type: 'function',
              function: jsonToolCall.function,
            },
          ],
        },
        { role: 'tool', tool_call_id: jsonToolCall.id, content: 'found' },
      ],
    }),
  });
  assert.equal(geminiReplay.status, 200);
  assert.equal(readThoughtSignature(lastGeminiBody.messages[1].tool_calls[0]), 'JSON-SIG');

  const geminiStream = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini:gemini-3.8-flash',
      stream: true,
      messages: [{ role: 'user', content: 'need-tools-stream' }],
    }),
  });
  assert.equal(geminiStream.status, 200);
  assert.match(await geminiStream.text(), /call_stream/);
  const geminiStreamReplay = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gemini:gemini-3.8-flash',
      messages: [
        { role: 'user', content: 'need-tools-stream' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_stream',
              type: 'function',
              function: { name: 'search_files', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_stream', content: 'found' },
      ],
    }),
  });
  assert.equal(geminiStreamReplay.status, 200);
  assert.equal(readThoughtSignature(lastGeminiBody.messages[1].tool_calls[0]), 'STREAM-SIG');

  const geminiBeforeSkip = geminiRequests;
  const geminiSkipProvider = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'tool-fallback',
      messages: [
        { role: 'user', content: 'force-thought-signature-400' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_force',
              type: 'function',
              function: { name: 'search_files', arguments: '{}' },
            },
          ],
        },
        { role: 'tool', tool_call_id: 'call_force', content: 'found' },
      ],
    }),
  });
  assert.equal(geminiSkipProvider.status, 502);
  const geminiSkipBody = await geminiSkipProvider.json();
  assert.equal(geminiSkipBody.error.failures.length, 1);
  assert.match(geminiSkipBody.error.failures[0].reason, /thought_signature/);
  assert.equal(geminiRequests, geminiBeforeSkip + 1);

  // Both quota models are in the route and both answer 429, but the reasons
  // differ and so must the consequences.
  for (const model of ['no-free-tier', 'daily-exhausted']) {
    const response = await fetch(`http://127.0.0.1:${routerPort}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: `quotamock:${model}`,
        messages: [{ role: 'user', content: 'hi' }],
      }),
    });
    assert.equal(response.status, 502);
  }

  const quotaHealth = await (await fetch(`http://127.0.0.1:${routerPort}/health`)).json();
  const verdicts = quotaHealth.discovery.modelVerdicts;

  // limit: 0 on every free-tier metric means waiting can never help, so the
  // model is dropped from the route rather than retried forever.
  assert.equal(verdicts['quotamock:no-free-tier'].free, false);
  assert.match(verdicts['quotamock:no-free-tier'].reason, /no free-tier allowance/);
  assert.equal(
    quotaHealth.routes['test-route'].some((entry) => entry.id === 'no-free-tier'),
    false,
  );

  // A positive limit proves the opposite: the model is free, just spent. It
  // stays in the route and the reported number becomes the daily limit, even
  // though no dailyLimits entry exists for it in config.
  assert.equal(verdicts['quotamock:daily-exhausted'].free, true);
  assert.equal(verdicts['quotamock:daily-exhausted'].dailyRequestLimit, 20);
  const exhaustedEntry = quotaHealth.routes['test-route'].find(
    (entry) => entry.id === 'daily-exhausted',
  );
  assert.equal(exhaustedEntry.usage.dailyLimit, 20);
  assert.equal(exhaustedEntry.usage.dailyLimitSource, 'provider');
  assert.equal(
    quotaHealth.usage.models.find((entry) => entry.key === 'quotamock:daily-exhausted')
      .dailyLimitSource,
    'provider',
  );
  // Exhausted for the day, so the wait runs to the quota reset rather than the
  // 42.5s the provider suggested for its per-minute window.
  assert.ok(exhaustedEntry.cooldownSeconds > 3600, `cooldown ${exhaustedEntry.cooldownSeconds}`);

  const leakResponse = await fetch(
    `http://127.0.0.1:${routerPort}/v1/chat/completions`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'glm-5.3-flash',
        messages: [
          {
            role: 'user',
            content: 'here is bai-test-key in chat',
          },
          {
            role: 'tool',
            content: 'BAI_API_KEY=bai-test-key\nOPENROUTER_API_KEY=test-key',
          },
        ],
      }),
    },
  );
  assert.equal(leakResponse.status, 200);
  const leaked = JSON.stringify(lastBaiBody);
  assert.equal(leaked.includes('bai-test-key'), false);
  assert.equal(leaked.includes('test-key'), false);
  assert.match(leaked, /\[REDACTED\]/);

  assert.ok(tokenRouterRequests >= 3);
  assert.ok(baiRequests >= 3);

  const usageHealth = await fetch(`http://127.0.0.1:${routerPort}/health`).then((res) =>
    res.json(),
  );
  const usage = usageHealth.usage;
  assert.equal(usage.timezone, 'UTC');
  assert.equal(usage.retentionDays, 3);
  assert.equal(usage.days.length, 3);
  const usageByKey = new Map(usage.models.map((entry) => [entry.key, entry]));
  assert.deepEqual(
    [...usageByKey.keys()].sort(),
    [
      'bai:glm-5.3-flash',
      // A probe spends a real request, so it is counted like any other.
      'bai:models/glm-5.3-paid',
      'bai:models/glm-5.3-pro',
      'extra:extra-1',
      'gemini:gemini-3.8-flash',
      'openrouter:acme/extra-1:free',
      'openrouter:mock-new',
      'quotamock:daily-exhausted',
      'quotamock:no-free-tier',
      'tokenrouter:z-ai/glm-5.3-free',
    ],
  );
  // The discovery evaluation burns real quota, so it has to be counted too.
  assert.equal(usageByKey.get('openrouter:mock-new').ok, 1);
  assert.equal(usageByKey.get('bai:glm-5.3-flash').ok, 4);
  assert.equal(usageByKey.get('bai:glm-5.3-flash').fail, 0);
  assert.equal(usageByKey.get('tokenrouter:z-ai/glm-5.3-free').ok, 1);
  assert.equal(usageByKey.get('tokenrouter:z-ai/glm-5.3-free').counts.rateLimit, 2);
  assert.equal(usageByKey.get('extra:extra-1').counts.rateLimit, 1);
  assert.equal(usageByKey.get('gemini:gemini-3.8-flash').ok, 5);
  assert.equal(usageByKey.get('gemini:gemini-3.8-flash').fail, 1);
  assert.equal(usageByKey.has('gemini:gemini-3.7-flash'), false);
  // Eight from routing, plus the successful probe of bai's glm-5.3-pro, plus
  // five Gemini tool-call round trips.
  assert.equal(usage.days[0].ok, 14);
  // Three routing failures, the two deliberate quota rejections, the probe
  // that found glm-5.3-paid has no free allowance, and one forced Gemini
  // thought-signature 400.
  assert.equal(usage.days[0].fail, 7);
  assert.equal(usage.days[0].topModel.key, 'gemini:gemini-3.8-flash');

  // A daily limit only counts attempts the provider actually served, so the
  // two tokenrouter 429s stay out of the consumed total.
  assert.equal(usageByKey.get('bai:glm-5.3-flash').dailyLimit, 5);
  assert.equal(usageByKey.get('bai:glm-5.3-flash').dailyLimitSource, 'config');
  assert.equal(usageByKey.get('bai:glm-5.3-flash').remainingToday, 1);
  assert.equal(usageByKey.get('tokenrouter:z-ai/glm-5.3-free').dailyLimit, 50);
  assert.equal(usageByKey.get('tokenrouter:z-ai/glm-5.3-free').remainingToday, 49);
  assert.equal(usageByKey.get('extra:extra-1').dailyLimit, null);
  assert.equal(usageByKey.get('extra:extra-1').remainingToday, null);
  // A 429 never reaches the model, so it does not burn today's consumed count.
  assert.equal(usageByKey.get('quotamock:no-free-tier').today.consumed, 0);

  const routeEntry = usageHealth.routes['test-route'].find(
    (entry) => `${entry.provider}:${entry.id}` === 'bai:glm-5.3-flash',
  );
  assert.equal(routeEntry.usage.today.ok, 4);
  assert.equal(routeEntry.usage.remainingToday, 1);

  const routeByKey = new Map(
    usageHealth.routes['test-route'].map((entry) => [`${entry.provider}:${entry.id}`, entry]),
  );
  // extra:extra-1 served 1 of 2 attempts, so reliability drags its score down
  // by the full clamped weight.
  const extraEntry = routeByKey.get('extra:extra-1');
  assert.equal(extraEntry.baseScore, 82);
  assert.equal(extraEntry.scoreAdjustment, -12);
  assert.equal(extraEntry.score, 70);
  // Pinned models are exempt from reliability adjustment.
  assert.equal(routeByKey.get('bai:glm-5.3-flash').scoreAdjustment, 0);
  // A group is ranked by its best provider, so the sibling's clean record keeps
  // the pair in place instead of the whole model sinking.
  assert.equal(routeByKey.get('openrouter:acme/extra-1:free').scoreAdjustment, 0);
  // Both quotamock models answered 429 earlier, yet only the one with no free
  // allowance is gone. The exhausted one is still a free model and comes back
  // when its quota resets, so it keeps its place.
  assert.deepEqual(
    usageHealth.routes['test-route'].map((entry) => `${entry.provider}:${entry.id}`),
    [
      'tokenrouter:z-ai/glm-5.3-free',
      'bai:glm-5.3-flash',
      'openrouter:mock-a',
      'openrouter:mock-new',
      'extra:extra-1',
      'openrouter:acme/extra-1:free',
      'quotamock:daily-exhausted',
      'bai:models/glm-5.3-pro',
    ],
  );

  const statePath = path.join(tempDir, 'discovered-free-models.json');
  const today = new Date().toISOString().slice(0, 10);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (persisted.usage?.[today]?.['bai:glm-5.3-flash']?.ok === 4) break;
    if (attempt === 39) throw new Error('usage counters were never persisted');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const base = `http://127.0.0.1:${routerPort}`;
  const pageResponse = await fetch(`${base}/`);
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get('content-type'), /text\/html/);
  assert.match(pageResponse.headers.get('content-security-policy'), /default-src 'none'/);
  const pageHtml = await pageResponse.text();
  assert.match(pageHtml, /Provider keys/);
  assert.match(pageHtml, /Route priority/);
  assert.equal(pageHtml.includes('Today\'s quota'), false);
  // The page is a template string; an apostrophe in a JS string must not be
  // written as \', or the browser sees a truncated literal and the UI is blank.
  const pageScript = pageHtml.split('<script>')[1]?.split('</script>')[0];
  assert.ok(pageScript);
  new Function(pageScript);

  const uiState = await fetch(`${base}/api/state`).then((res) => res.json());
  const uiProviders = new Map(uiState.providers.map((entry) => [entry.name, entry]));
  assert.equal(uiProviders.get('bai').configured, true);
  // Gemini is listed first when present; this test config has no gemini, so the
  // first row stays whoever was declared first.
  if (uiProviders.has('gemini')) assert.equal(uiState.providers[0].name, 'gemini');
  assert.equal(uiProviders.get('bai').keyEnv, 'BAI_API_KEY');
  // The real key must never leave the process, only a recognisable stub.
  assert.equal(uiProviders.get('bai').maskedKey.includes('bai-test-key'), false);
  assert.equal(JSON.stringify(uiState).includes('bai-test-key'), false);
  assert.ok(uiState.usage.models.length > 0);
  assert.ok(uiState.routes.length > 0);

  // The interface warns about a rejection only when it contradicts config.json.
  // quotamock:no-free-tier was written into the route by hand, so its refusal is
  // worth surfacing; bai's glm-5.3-paid was merely a probe candidate, and
  // listing every one of those would bury the case that needs attention.
  assert.deepEqual(
    uiState.excludedByProvider.map((entry) => entry.key),
    ['quotamock:no-free-tier'],
  );
  assert.match(uiState.excludedByProvider[0].reason, /no free-tier allowance/);
  // Still recorded in full for diagnosis, just not shown as a warning.
  const fullVerdicts = await (await fetch(`${base}/health`)).json();
  assert.equal(fullVerdicts.discovery.modelVerdicts['bai:models/glm-5.3-paid'].free, false);

  // A browser request from another site must be rejected before it can write.
  const csrf = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'cross-site' },
    body: JSON.stringify({ provider: 'bai', key: 'attacker-key' }),
  });
  assert.equal(csrf.status, 403);
  // fetch() silently drops a Host override, so this one needs a raw request.
  const rebind = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: '127.0.0.1',
        port: routerPort,
        path: '/api/state',
        method: 'GET',
        headers: { Host: 'evil.example.com' },
      },
      (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      },
    );
    request.on('error', reject);
    request.end();
  });
  assert.equal(rebind, 403);
  const badOrigin = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example.com' },
    body: JSON.stringify({ provider: 'bai', key: 'attacker-key' }),
  });
  assert.equal(badOrigin.status, 403);

  // Only known providers, so the env file cannot gain arbitrary variables.
  const unknownProvider = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'NODE_OPTIONS', key: '--require /tmp/evil.js' }),
  });
  assert.equal(unknownProvider.status, 400);
  const newlineInjection = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'bai', key: 'ok\nNODE_OPTIONS=--require /tmp/evil.js' }),
  });
  assert.equal(newlineInjection.status, 400);

  const envPath = path.join(tempDir, '.env');
  assert.equal(fs.existsSync(envPath), false);

  const saved = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin' },
    body: JSON.stringify({ provider: 'bai', key: 'bai-rotated-key' }),
  });
  assert.equal(saved.status, 200);
  const envBody = fs.readFileSync(envPath, 'utf8');
  assert.equal(envBody, 'BAI_API_KEY=bai-rotated-key\n');
  assert.equal(fs.statSync(envPath).mode & 0o777, 0o600);
  assert.equal(process.env.NODE_OPTIONS, undefined);

  // The new key has to apply without a restart, and the redactor has to learn
  // it so it cannot leak back out through an upstream payload.
  await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'glm-5.3-flash',
      messages: [{ role: 'user', content: 'echo bai-rotated-key please' }],
    }),
  });
  assert.equal(lastBaiAuth, 'Bearer bai-rotated-key');
  assert.equal(JSON.stringify(lastBaiBody).includes('bai-rotated-key'), false);

  const cleared = await fetch(`${base}/api/keys`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'bai', key: '' }),
  });
  assert.equal(cleared.status, 200);
  assert.equal(fs.readFileSync(envPath, 'utf8'), '');
  const afterClear = await fetch(`${base}/api/state`).then((res) => res.json());
  assert.equal(
    afterClear.providers.find((entry) => entry.name === 'bai').configured,
    false,
  );

  console.log(
    'smoke test passed: pluggable providers, ranking, fallback, discovery, usage counters, and tracking work',
  );
} finally {
  child.kill('SIGTERM');
  // Wait for the router to exit so its shutdown state write cannot race the
  // temp directory cleanup.
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 3000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await close(mock);
  await close(tokenRouterMock);
  await close(baiMock);
  await close(extraMock);
  await close(quotaMock);
  await close(geminiMock);
  fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 3 });
}
