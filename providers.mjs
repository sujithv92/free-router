const PROVIDER_ID = /^[a-z][a-z0-9_-]*$/;

export function isZeroCost(model) {
  const prompt = Number(model?.pricing?.prompt);
  const completion = Number(model?.pricing?.completion);
  return Number.isFinite(prompt) && Number.isFinite(completion) && prompt === 0 && completion === 0;
}

export function isChatModel(model) {
  // A catalog that states which generation methods a model supports is
  // authoritative; guessing from modalities is only for catalogs that do not.
  if (typeof model?.chatCapable === 'boolean') return model.chatCapable;
  const outputs = model?.architecture?.output_modalities || ['text'];
  if (!outputs.includes('text') || outputs.some((modality) => modality !== 'text')) return false;
  if (model?.architecture?.tokenizer === 'Router') return false;
  return !/(?:content[-_ ]?safety|moderation|guard)(?:[:/_-]|$)/i.test(model?.id || '');
}

// A catalog that lists parameters can rule a model out. Missing or empty means
// the listing did not say, which is not the same as "cannot use tools".
export function supportsRequest(model, needs) {
  if (!model) return true;
  const listed = model.supported_parameters;
  if (Array.isArray(listed) && listed.length) {
    const supported = new Set(listed);
    if (needs.tools && !supported.has('tools')) return false;
    if (
      needs.responseFormat &&
      !supported.has('response_format') &&
      !supported.has('structured_outputs')
    ) {
      return false;
    }
  }
  const inputs = model.architecture?.input_modalities;
  if (Array.isArray(inputs) && inputs.length) {
    const allowed = new Set(inputs);
    for (const modality of needs.modalities || []) {
      if (!allowed.has(modality)) return false;
    }
  }
  return true;
}

// Google's native /v1beta/models speaks a different dialect than the
// OpenAI-compatible listing: models[] keyed by `name`, capabilities in
// `supportedGenerationMethods`, and no pricing at all. Normalizing here keeps
// the rest of the router on one model shape.
export function normalizeCatalogPayload(payload) {
  if (Array.isArray(payload?.data)) {
    return {
      shape: 'openai',
      models: payload.data.filter((model) => model && typeof model.id === 'string'),
      nextPageToken: '',
    };
  }
  if (!Array.isArray(payload?.models)) return { shape: 'unknown', models: [], nextPageToken: '' };
  const models = [];
  for (const raw of payload.models) {
    if (!raw || typeof raw.name !== 'string') continue;
    const methods = Array.isArray(raw.supportedGenerationMethods)
      ? raw.supportedGenerationMethods
      : [];
    models.push({
      id: raw.name.replace(/^models\//, ''),
      name: raw.displayName || '',
      description: raw.description || '',
      context_length: Number(raw.inputTokenLimit || 0),
      max_output_tokens: Number(raw.outputTokenLimit || 0),
      // Text chat is exactly `generateContent`. Embeddings expose
      // `embedContent`, video `predictLongRunning`, live audio
      // `bidiGenerateContent`, and none of those belong in a chat route.
      chatCapable: methods.includes('generateContent'),
      supportedGenerationMethods: methods,
      // supported_parameters is omitted on purpose: this listing does not
      // describe OpenAI-style tools, and an empty list would skip the model.
    });
  }
  return { shape: 'google', models, nextPageToken: String(payload.nextPageToken || '') };
}

function envName(providerName, suffix) {
  return `${String(providerName).replace(/-/g, '_').toUpperCase()}_${suffix}`;
}

export function normalizeModelSlug(id) {
  let slug = String(id || '').toLowerCase().trim();
  slug = slug.replace(/:free$/, '');
  const slash = slug.lastIndexOf('/');
  if (slash >= 0) slug = slug.slice(slash + 1);
  return slug;
}

function resolveHeaderValue(spec, { host, port }) {
  const origin = `http://${host}:${port}`;
  const expand = (value) => (value === '${origin}' ? origin : value);
  if (typeof spec === 'string') return expand(spec);
  if (!spec || typeof spec !== 'object') return '';
  const fromEnv = spec.env ? process.env[spec.env] : '';
  if (fromEnv) return fromEnv;
  return expand(spec.default || '');
}

function joinUrl(baseUrl, path) {
  const prefix = String(baseUrl || '').replace(/\/+$/, '');
  const suffix = String(path || '').startsWith('/') ? path : `/${path || ''}`;
  return `${prefix}${suffix}`;
}

// Some providers scope their endpoint to the account rather than to the key:
// Cloudflare Workers AI serves chat under /accounts/<account_id>/ai/v1, so the
// account id is part of the URL and cannot be a header. Letting a base URL
// reference the environment keeps that out of the committed config. An unset
// name expands to empty rather than throwing, so an unconfigured provider just
// fails its first request instead of blocking startup.
function expandEnvVars(value) {
  return String(value || '').replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (match, name) => process.env[name] || '',
  );
}

export function createProviderRegistry(config, { host, port }) {
  const entries = Object.entries(config.providers || {});
  if (!entries.length) throw new Error('config.providers is empty');

  const providers = new Map();
  for (const [name, raw] of entries) {
    if (!PROVIDER_ID.test(name)) {
      throw new Error(`invalid provider id "${name}"; use lowercase letters, digits, _ or -`);
    }
    const cfg = raw && typeof raw === 'object' ? raw : {};
    const keyEnv = cfg.keyEnv || envName(name, 'API_KEY');
    const baseUrlEnv = cfg.baseUrlEnv || envName(name, 'BASE_URL');
    const usesCatalog = cfg.catalog === true;
    // Fetching /models and deciding what is free are separate powers. Only a
    // catalog that publishes per-token prices can decide freeness by itself;
    // for the rest `freeModels` stays the allowlist and the catalog is used
    // solely to notice models that disappeared upstream.
    const catalogHasPricing = usesCatalog && cfg.pricing !== false;
    const baseUrl = expandEnvVars(process.env[baseUrlEnv] || cfg.baseUrl || '').replace(
      /\/+$/,
      '',
    );
    if (!baseUrl) throw new Error(`provider ${name} is missing baseUrl`);
    providers.set(name, {
      name,
      keyEnv,
      baseUrlEnv,
      usesCatalog,
      catalogHasPricing,
      // Adding unknown models from a catalog is only safe where prices are
      // published, so a priced catalog is a precondition for that route in.
      discover: catalogHasPricing && cfg.discover !== false,
      // The other way in: no prices, so ask the provider directly whether it
      // will serve the model for free. Opt-in, since it spends a request per
      // candidate and is only sound on a key with no billing attached.
      probeFreeTier: usesCatalog && !catalogHasPricing && cfg.probeFreeTier === true,
      chatPath: cfg.chatPath || '/chat/completions',
      modelsPath: cfg.modelsPath || '/models',
      // Some providers serve a richer catalog outside the OpenAI-compatible
      // prefix used for chat, on its own auth scheme.
      modelsUrl: expandEnvVars(cfg.modelsUrl || ''),
      modelsKeyHeader: String(cfg.modelsKeyHeader || ''),
      extraHeaders: cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {},
      baseUrl,
      apiKey: process.env[keyEnv] || '',
      freeModels: new Set(cfg.freeModels || []),
      catalog: usesCatalog ? new Map() : null,
      catalogSlugs: usesCatalog ? new Map() : null,
      catalogFetchedAt: 0,
      catalogAttemptedAt: 0,
      catalogError: '',
    });
  }

  const configuredDefault = config.defaultProvider;
  if (configuredDefault && !providers.has(configuredDefault)) {
    throw new Error(`defaultProvider "${configuredDefault}" is not in providers`);
  }
  const defaultProvider =
    configuredDefault ||
    [...providers.values()].find((provider) => provider.catalogHasPricing)?.name ||
    [...providers.keys()][0];

  const configuredDiscovery = config.discovery?.provider;
  if (configuredDiscovery && !providers.has(configuredDiscovery)) {
    throw new Error(`discovery.provider "${configuredDiscovery}" is not in providers`);
  }
  const discoveryProvider =
    configuredDiscovery ||
    [...providers.values()].find((provider) => provider.discover)?.name ||
    defaultProvider;

  function get(name) {
    return providers.get(name);
  }

  function headers(name) {
    const provider = get(name);
    const resolved = {
      Authorization: `Bearer ${provider?.apiKey || ''}`,
      'Content-Type': 'application/json',
    };
    for (const [header, spec] of Object.entries(provider?.extraHeaders || {})) {
      const value = resolveHeaderValue(spec, { host, port });
      if (value) resolved[header] = value;
    }
    return resolved;
  }

  // Providers disagree on how to spell the same model: Gemini's OpenAI-compat
  // catalog returns "models/gemini-3.8-flash" where config.json says
  // "gemini-3.8-flash". Fall back to the slug so a naming difference does not
  // read as a model that vanished upstream.
  function catalogEntry(provider, modelId) {
    if (!provider?.catalog) return null;
    const exact = provider.catalog.get(modelId);
    if (exact) return exact;
    const slug = normalizeModelSlug(modelId);
    return (slug && provider.catalogSlugs?.get(slug)) || null;
  }

  function metadata(candidate) {
    const provider = get(candidate.provider);
    return provider?.usesCatalog ? catalogEntry(provider, candidate.model) : null;
  }

  function isFree(candidate) {
    const provider = get(candidate.provider);
    if (!provider || !provider.apiKey) return false;
    if (provider.catalogHasPricing) {
      const model = provider.catalog.get(candidate.model);
      return !provider.catalog.size || Boolean(model && isZeroCost(model) && isChatModel(model));
    }
    if (!provider.freeModels.has(candidate.model)) return false;
    // A catalog that failed to load must not empty the route, so absence only
    // counts as removal when we actually hold a catalog to check against.
    if (!provider.usesCatalog || !provider.catalog.size) return true;
    return Boolean(catalogEntry(provider, candidate.model));
  }

  // Allowlisted models the provider no longer offers. Attempting these wastes
  // an upstream round trip and a cooldown slot on a guaranteed 404.
  function unavailableFreeModels() {
    const missing = [];
    for (const provider of providers.values()) {
      if (!provider.usesCatalog || provider.catalogHasPricing) continue;
      if (!provider.apiKey || !provider.catalog.size) continue;
      for (const id of provider.freeModels) {
        if (!catalogEntry(provider, id)) missing.push(`${provider.name}:${id}`);
      }
    }
    return missing.sort();
  }

  function parsePrefixed(requestedModel) {
    const separator = requestedModel.indexOf(':');
    if (separator <= 0) return null;
    const providerName = requestedModel.slice(0, separator);
    const model = requestedModel.slice(separator + 1);
    if (!providers.has(providerName) || !model) return null;
    return { provider: providerName, model };
  }

  function offeringsForSlug(slug) {
    const normalized = String(slug || '');
    if (!normalized) return [];
    const offerings = [];
    const seen = new Set();
    for (const provider of providers.values()) {
      if (!provider.apiKey) continue;
      if (provider.catalogHasPricing) {
        if (!provider.catalog) continue;
        for (const model of provider.catalog.values()) {
          if (normalizeModelSlug(model.id) !== normalized) continue;
          if (!isZeroCost(model) || !isChatModel(model)) continue;
          const key = `${provider.name}:${model.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          offerings.push({ provider: provider.name, model: model.id });
        }
        continue;
      }
      for (const id of provider.freeModels) {
        if (normalizeModelSlug(id) !== normalized) continue;
        if (provider.usesCatalog && provider.catalog.size && !catalogEntry(provider, id)) continue;
        const key = `${provider.name}:${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        offerings.push({ provider: provider.name, model: id });
      }
    }
    return offerings;
  }

  function directCandidates(requestedModel) {
    const prefixed = parsePrefixed(requestedModel);
    if (prefixed) return [prefixed];
    const slug = normalizeModelSlug(requestedModel);
    const offerings = offeringsForSlug(slug);
    if (!offerings.length) {
      return [{ provider: defaultProvider, model: requestedModel }];
    }
    const exact = [];
    const rest = [];
    for (const offering of offerings) {
      if (offering.model === requestedModel) exact.push(offering);
      else rest.push(offering);
    }
    return [...exact, ...rest];
  }

  function catalogUrl(provider) {
    return provider.modelsUrl || joinUrl(provider.baseUrl, provider.modelsPath);
  }

  function catalogHeaders(provider) {
    if (!provider.apiKey) return undefined;
    // Google's native endpoint rejects a Bearer token with 401 and wants its
    // own header. Keeping the key out of the query string keeps it out of logs.
    if (provider.modelsKeyHeader) return { [provider.modelsKeyHeader]: provider.apiKey };
    return { Authorization: `Bearer ${provider.apiKey}` };
  }

  async function fetchCatalogPage(provider, pageToken) {
    const url = new URL(catalogUrl(provider));
    if (provider.modelsUrl) url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const response = await fetch(url, {
      headers: catalogHeaders(provider),
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return normalizeCatalogPayload(await response.json());
  }

  async function refreshProviderCatalog(provider, force, catalogRefreshMs) {
    if (!provider.usesCatalog) return;
    // A keyless provider cannot authenticate a catalog request. Skipping it
    // keeps the refresh interval from spending one round trip per provider the
    // operator never configured, which matters once the config lists many.
    if (!provider.apiKey) return;
    if (
      !force &&
      Date.now() - provider.catalogAttemptedAt < catalogRefreshMs &&
      (provider.catalog.size || provider.catalogError)
    ) {
      return;
    }
    provider.catalogAttemptedAt = Date.now();
    try {
      const listed = [];
      let pageToken = '';
      // A truncated listing is indistinguishable from models withdrawn
      // upstream, so follow pagination rather than trusting the first page.
      for (let page = 0; page < 10; page += 1) {
        const result = await fetchCatalogPage(provider, pageToken);
        if (result.shape === 'unknown') throw new Error('unrecognised catalog response shape');
        listed.push(...result.models);
        pageToken = result.nextPageToken;
        if (!pageToken) break;
      }
      if (!listed.length) throw new Error('catalog response listed no models');
      provider.catalog = new Map(listed.map((model) => [model.id, model]));
      provider.catalogSlugs = new Map();
      for (const model of listed) {
        const slug = normalizeModelSlug(model.id);
        if (slug && !provider.catalogSlugs.has(slug)) provider.catalogSlugs.set(slug, model);
      }
      provider.catalogFetchedAt = Date.now();
      provider.catalogError = '';
      const freeCount = provider.catalogHasPricing
        ? [...provider.catalog.values()].filter(isZeroCost).length
        : null;
      const chatCount = [...provider.catalog.values()].filter(isChatModel).length;
      return { name: provider.name, size: provider.catalog.size, freeCount, chatCount };
    } catch (error) {
      provider.catalogError = error instanceof Error ? error.message : String(error);
      throw new Error(`${provider.name}: ${provider.catalogError}`);
    }
  }

  // Refreshing one provider at a time made the first request after startup
  // wait for every catalog in turn: 25 providers at 700ms each measured 17.6s,
  // and handleChat awaits this. Bounded rather than unbounded so a cold start
  // does not fire every listing at once and trip provider rate limits.
  async function refreshCatalogs(force, catalogRefreshMs, log, concurrency = 6) {
    const queue = [...providers.values()].filter((provider) => provider.usesCatalog);
    const worker = async () => {
      // shift() is synchronous, so workers cannot take the same provider.
      for (let next = queue.shift(); next; next = queue.shift()) {
        try {
          const result = await refreshProviderCatalog(next, force, catalogRefreshMs);
          if (result) {
            const detail =
              result.freeCount === null
                ? `${result.chatCount} chat-capable, no prices published`
                : `${result.freeCount} zero-cost`;
            log(`catalog refreshed (${result.name}): ${result.size} models, ${detail}`);
          }
        } catch (error) {
          log(
            `catalog refresh failed for ${next.name}; retaining previous catalog: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    };
    const workers = Math.min(concurrency, queue.length);
    await Promise.all(Array.from({ length: workers }, worker));
  }

  function listListedModels() {
    const models = [];
    const ids = new Set();
    for (const provider of providers.values()) {
      if (!provider.apiKey || provider.catalogHasPricing) continue;
      for (const id of provider.freeModels) {
        if (ids.has(id)) continue;
        if (provider.usesCatalog && provider.catalog.size && !catalogEntry(provider, id)) continue;
        ids.add(id);
        models.push({
          id,
          object: 'model',
          created: 0,
          owned_by: provider.name,
          context_length: 0,
        });
      }
    }
    return { models, ids };
  }

  function listCatalogModels(excludeIds = new Set()) {
    const models = [];
    const seen = new Set(excludeIds);
    for (const provider of providers.values()) {
      if (!provider.catalogHasPricing || !provider.catalog) continue;
      for (const model of provider.catalog.values()) {
        if (!isZeroCost(model) || !isChatModel(model) || seen.has(model.id)) continue;
        seen.add(model.id);
        models.push({
          id: model.id,
          object: 'model',
          created: Number(model.created || 0),
          owned_by: model.id.split('/')[0] || provider.name,
          context_length: Number(model.context_length || 0),
          provider: provider.name,
        });
      }
    }
    models.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return models;
  }

  // 'catalog' lets prices decide what is free; 'static' trusts the freeModels
  // allowlist; 'static+catalog' trusts the allowlist but still consults the
  // catalog to drop models the provider stopped offering.
  function providerKind(provider) {
    if (provider.catalogHasPricing) return 'catalog';
    return provider.usesCatalog ? 'static+catalog' : 'static';
  }

  function health() {
    const unavailable = new Set(unavailableFreeModels());
    return Object.fromEntries(
      [...providers.entries()].map(([name, provider]) => [
        name,
        {
          configured: Boolean(provider.apiKey),
          kind: providerKind(provider),
          baseUrl: provider.baseUrl,
          freeModels: provider.catalogHasPricing ? undefined : [...provider.freeModels],
          unavailableModels: provider.catalogHasPricing
            ? undefined
            : [...provider.freeModels].filter((id) => unavailable.has(`${name}:${id}`)),
          catalogModels: provider.usesCatalog ? provider.catalog.size : undefined,
          catalogFetchedAt:
            provider.usesCatalog && provider.catalogFetchedAt
              ? new Date(provider.catalogFetchedAt).toISOString()
              : undefined,
          catalogError: provider.usesCatalog ? provider.catalogError || null : undefined,
        },
      ]),
    );
  }

  function discoveryCatalog() {
    return get(discoveryProvider);
  }

  // Applied to the live provider and to process.env, so a key set at runtime
  // works on the next request without a restart.
  function setApiKey(name, key) {
    const provider = get(name);
    if (!provider) return false;
    const value = String(key || '');
    provider.apiKey = value;
    if (value) process.env[provider.keyEnv] = value;
    else delete process.env[provider.keyEnv];
    if (provider.usesCatalog && !value) {
      provider.catalog = new Map();
      provider.catalogSlugs = new Map();
      provider.catalogFetchedAt = 0;
      provider.catalogAttemptedAt = 0;
      provider.catalogError = '';
    }
    return true;
  }

  return {
    providers,
    defaultProvider,
    discoveryProvider,
    get,
    headers,
    metadata,
    isFree,
    parsePrefixed,
    offeringsForSlug,
    directCandidates,
    refreshCatalogs,
    listListedModels,
    listCatalogModels,
    health,
    discoveryCatalog,
    catalogEntry,
    unavailableFreeModels,
    providerKind,
    setApiKey,
    chatUrl(name) {
      const provider = get(name);
      return provider ? joinUrl(provider.baseUrl, provider.chatPath) : '';
    },
  };
}
