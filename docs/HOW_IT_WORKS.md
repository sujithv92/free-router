# How Free Router works

Technical reference. The short overview lives in the [README](../README.md).

## Requirements

- Node.js 20+
- An API key for at least one provider in `config.json`

A missing key just drops that provider from ranking.

## Configure API keys

Keys are never stored in `config.json` or committed to git. Copy the example
file, uncomment the keys you have, and fill them in:

```bash
cp .env.example .env
```

`OPENROUTER_API_KEY` is the one variable worth having: it drives OpenRouter
fallbacks and the weekly discovery run. Everything else is optional. The full
list of 29 supported providers, with signup links and free-tier limits, is in
the [README](../README.md#providers).

Any later provider named `foo` reads `FOO_API_KEY` and `FOO_BASE_URL` unless
you override `keyEnv` / `baseUrlEnv` in config. A provider with no key is
dropped entirely — it is skipped for routing, for catalog refresh, and in the
model list.

Lookup order, first non-empty value wins:

1. Process environment (`export OPENROUTER_API_KEY=...`)
2. `.env` in the project directory
3. `~/.hermes/.env`, if you already keep keys there

`.env` is gitignored. Do not put keys in the systemd unit, README, or config.

Optional settings are listed in `.env.example`: listen address, upstream base
URLs, and the OpenRouter app title/referer.

`.env.example` writes only the variables a deployment genuinely needs as real
`NAME=` lines, and keeps every optional one commented out. That split exists
because deploy platforms scan the repo for `NAME=value` pairs to prefill their
environment-variable screen and mark everything they find **Required**: a
commented-out name is invisible to the scan, so it stays documentation instead
of becoming a field you must fill before the platform will build. Nothing is
lost by commenting a key out: you type the name in on the deploy screen or in
the platform's settings, and a variable added there is injected exactly like a
detected one.

## Container deploys

`server.mjs` binds `FREE_ROUTER_HOST` and listens on
`FREE_ROUTER_PORT`, falling back to `PORT` and then to `config.port`. A
platform that assigns the port and injects it as `PORT` — SnapDeploy sets and
locks it — therefore needs no configuration. The Dockerfile pins
`FREE_ROUTER_HOST=0.0.0.0`, because a platform reverse proxy cannot reach
`127.0.0.1`.

## Run

```bash
git clone https://github.com/www222fff/free-router.git
cd free-router
cp .env.example .env
# edit .env and set the keys you have
./start.sh
```

The gateway listens on `127.0.0.1:8787` by default. Stop it with `./stop.sh`.
Run these scripts as a normal user. If started as root, they re-exec as the
directory owner and refuse to stay root.

## Run with Docker

```bash
git clone https://github.com/www222fff/free-router.git
cd free-router
cp .env.example .env
# edit .env and set the keys you have
docker compose up -d
```

The gateway is reachable at `http://127.0.0.1:8787/v1`, the same address as
the non-Docker run. Keys are injected at runtime from `.env` and never baked
into the image. Weekly-discovery state is ephemeral: it lives inside the
container and is reset on rebuild (the gateway re-discovers free models on
the weekly schedule).

```bash
docker compose ps
docker compose logs -f
docker compose down
```

To pick up code changes, rebuild and recreate:

```bash
docker compose up -d --build
```

Foreground:

```bash
node server.mjs
```

List the current `free-best` priority (same order the gateway will try models):

```bash
./models.sh
./models.sh --ready-only
npm run models -- --json
```

See where requests actually landed, and how much of today's quota is left:

```bash
./models.sh --usage
```

## Web interface

Open <http://127.0.0.1:8787/> to set provider keys and read usage. A saved key
is written to the env file and applied to the running process immediately, so
no restart is needed.

```json
"ui": {
  "enabled": true,
  "envFile": ".env"
}
```

Set `enabled: false` to remove `/` and `/api/*` entirely.

### Why this needs care

The router takes no caller credential on loopback, and a page open in your
browser can send requests to localhost. Since `start.sh` sources the env file
with `set -a`, being able to write an arbitrary variable there would mean code
execution on the next start. The write path is therefore constrained:

- Keys are addressed **by provider name**, never by raw variable name. The
  server resolves `keyEnv` from `config.json`, so nothing outside a configured
  provider's key variable can ever be written.
- Values containing a newline or NUL are rejected, so one field cannot append
  a second assignment.
- The env file is written atomically with mode `0600`, and an existing file is
  chmod'ed down to match.
- `/` and `/api/*` require the peer to be on loopback, the `Host` header to be
  a loopback name (blocking DNS rebinding), and the request not to be
  cross-site per `Origin` / `Sec-Fetch-Site` (blocking CSRF). A plain `curl`
  call sends neither header and still works. A request that carries a valid
  `Authorization: Bearer $FREE_ROUTER_API_KEY` passes instead of these, which is
  the only way to reach the interface once the gateway is deployed off
  loopback.
- Keys are returned masked, never in full.
- The secret redactor is rebuilt after a key change, so a key added through the
  UI is still stripped from upstream payloads.

`/v1/*` and `/health` are unguarded only while `FREE_ROUTER_API_KEY` is unset —
fine on `127.0.0.1`, where the loopback is the access control. Set the token and
both require it, because a container platform puts the same port on the public
internet. The value is not issued by anyone; you generate it
(`openssl rand -hex 32`) and callers send it as their API key. It is read once
at startup. `.env` is dockerignored, so on a deployed instance the file the UI
writes lives only in that container's writable layer and is gone after the next
build — keep durable values in the platform's own environment variables instead.

## Use with any OpenAI-compatible client

On loopback the server takes no caller credential — the loopback is the access
control — so `api_key` can be any string, and upstream provider keys stay on the
gateway. Once you deploy it, set `FREE_ROUTER_API_KEY` and hand that value to
clients as their API key instead; see the interface guard above.

**curl**

```bash
curl -s http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "free-best",
    "messages": [{"role": "user", "content": "Reply with exactly: router-ok"}]
  }'
```

**OpenAI SDK**

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8787/v1", api_key="local")
print(client.chat.completions.create(
    model="free-best",
    messages=[{"role": "user", "content": "Hello"}],
).choices[0].message.content)
```

**Hermes**

```yaml
model:
  default: free-best
  provider: custom
  base_url: http://127.0.0.1:8787/v1
custom_providers:
  - name: free-router
    base_url: http://127.0.0.1:8787/v1
    api_key: local
    api_mode: chat_completions
    discover_models: true
    models:
      - free-best
```

Or add a `model_aliases.free-best` entry and switch with `/model free-best`.

The selected upstream is returned in `X-Free-Router-Provider` and
`X-Free-Router-Model`, plus the provider's normal `model` field.

## Endpoints

```text
GET  /                       web interface
GET  /api/state              providers (masked keys), usage, route priority
POST /api/keys               { "provider": "gemini", "key": "..." }
GET  /health
GET  /v1/models
POST /v1/chat/completions
```

`GET /health` reports `version` from `package.json` (currently `1.0.0`). Releases are
git tags of the form `v1.0.0`.

`GET /v1/models` returns the route alias, each static provider's `freeModels`,
and every currently free text-chat model from catalog providers. A listed
concrete model ID can be selected directly; the gateway then tries every
provider that currently offers that same model. Prefix with `provider:` to
force a single provider.

```bash
curl -s http://127.0.0.1:8787/health | jq
```

## Routes

- `free-best`: one ranked list of models; the same model can be tried from
  more than one provider

Edit `config.json` to change ordering, timeout, and cooldowns. Pin entries with
`provider:model` in `discovery.evaluation.pinnedModels`. Models without a key,
or that are no longer free, are skipped. IDs that differ only by org prefix or
a `:free` suffix (for example `gemini-3.8-flash` and
`google/gemini-3.8-flash:free`) count as the same model.

## Add a provider

No code change is needed for an OpenAI-compatible `/chat/completions` endpoint.
The registry in `providers.mjs` loads every block under `config.json`
`providers`.

1. Add a provider object. Set `"catalog": true` if it exposes `GET /models`.
   Add `"pricing": true` only when that response carries per-token prices;
   otherwise keep `freeModels` as the allowlist (see below).
2. Insert `{ "provider": "<name>", "model": "<id>" }` into `routes.free-best`
   where you want it ranked. Bare strings belong to `defaultProvider`.
3. Optionally pin `name:model` in `discovery.evaluation.pinnedModels`.
4. Set `<NAME>_API_KEY` in `.env` or `~/.hermes/.env`. Override the URL with
   `<NAME>_BASE_URL` if needed.
5. Add a commented `# NAME=` line to `.env.example`, with the signup URL above
   it, and a row to the README table. The smoke test fails if a provider key is
   missing from either. Keep the `.env.example` line commented: an uncommented
   `NAME=` is read by deploy platforms as a **Required** variable, and a
   provider you have no key for is meant to be optional.
6. Restart.

```json
"newvendor": {
  "baseUrl": "https://api.example.com/v1",
  "freeModels": ["example-free"]
}
```

Two optional refinements:

- `baseUrl` and `modelsUrl` expand `${ENV_VAR}` from the environment. Use this
  when the account is part of the path rather than a header, as with Cloudflare
  Workers AI: `.../accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1`. An unset name
  expands to empty instead of throwing, so an unconfigured provider fails its
  first request rather than blocking startup.
- `"probeFreeTier": true` asks the provider whether it will serve each catalog
  model for free and remembers the answer. It spends one request per candidate,
  so it is only sound on a key with no billing attached. Leave it off for
  providers that bill per token beyond an allowance.

Optional fields: `keyEnv`, `baseUrlEnv`, `headers`, `chatPath`, `modelsPath`,
`discover: false` to keep a priced catalog provider out of discovery, and
`probeFreeTier: true` to let a price-free catalog contribute models by probing.

Two fields cover a catalog served outside the chat prefix, on its own auth:
`modelsUrl` for an absolute listing URL and `modelsKeyHeader` for the header
carrying the key. Gemini needs both, because its native listing is the only
place `supportedGenerationMethods` appears and it answers `401` to a Bearer
token. Either response shape is accepted: OpenAI's `data[].id` or Google's
`models[].name`.

### What each provider contributes to discovery

`catalog` and `pricing` are separate switches, because fetching `/models` and
being able to tell free from paid are separate capabilities.

| `kind` | Config | Free models come from | Discovery role |
|---|---|---|---|
| `catalog` | `catalog: true, pricing: true` | zero-priced catalog entries | adds and removes models |
| `static+catalog` | `catalog: true, pricing: false` | `freeModels`, plus anything the provider serves for free | removals, and additions when `probeFreeTier` is on |
| `static` | neither | `freeModels` | none |

Only OpenRouter publishes prices, so only OpenRouter can add unknown models
from a catalog alone. Gemini's and TokenRouter's `/models` carry no `pricing`
field and mix free and paid models, so auto-adding from the listing could route
traffic to a billed model. Their catalogs are still fetched for two things:
dropping a `freeModels` entry that has disappeared upstream, and supplying
candidates for probing (below). A withdrawn model returns automatically once
the provider lists it again.

A catalog that fails to load, returns nothing, or belongs to a provider with no
key changes nothing: `freeModels` stays authoritative. Removal requires a
catalog that actually loaded, so an upstream outage cannot empty a route.

Model IDs are matched by slug, so Gemini listing `models/gemini-3.8-flash`
against a configured `gemini-3.8-flash` is not read as a withdrawal.

`/health` reports this under `discovery.addsFrom`,
`discovery.availabilityOnly`, and `discovery.unavailableModels`; the web UI
shows withdrawn models next to the owning provider.

## Free-model discovery

The router checks each `discover`-enabled catalog provider every `discovery.intervalMs`
(currently every 2 days) for newly free text-generation models. Each new model receives one cached hybrid evaluation
using deterministic reasoning/instruction checks, response latency, context
size, and tool/structured output support. Its score places it among the
manually ranked models in `free-best`.

Scores are made of three parts, capped so no single part can dominate:

| Part | Max | Notes |
|---|---|---|
| benchmark | 65 | 10 deterministic items; the 3 hardest carry 28 points |
| metadata | 20 | tools, structured output, context length, modality, recency |
| latency | 6 | one cold sample, so deliberately a small tiebreaker |

A model is re-evaluated when its stored score is missing, still `pending`, or
was produced by an older benchmark version. Without this, a model whose single
evaluation attempt hit a 429 would keep the fallback score of `-1` and stay
last forever, because it was already tracked and so never looked like a new
discovery again. At most `evaluation.maxPerRun` models are evaluated per run.

Ranking also reacts to real traffic. Once a model has at least
`evaluation.usageMinRequests` recorded attempts in the usage window, its
success rate shifts its score by up to `evaluation.usageWeight` points: 100%
success adds the full weight, 80% is neutral, 60% or worse subtracts the full
weight. Pinned models are exempt. When one model is offered by several
providers, the group is ranked by its best provider, so one bad provider does
not sink the model. `./models.sh` shows the current shift in the `rank+-`
column, and `/health` reports `baseScore` and `scoreAdjustment` per entry.

### Asking a provider what is free

A provider without prices in its catalog can still answer the question, just
not in the listing. With `probeFreeTier: true`, each unknown chat model gets one
real request and the reply is read as the answer:

| Reply | Meaning | Effect |
|---|---|---|
| `200` | served on this key | free; enters the route with its evaluation score |
| `429`, every free-tier `limit: 0` | no free allowance exists | dropped from routes |
| `429`, some `limit` above `0` | free, but spent for now | kept; the number becomes its daily limit |
| `404` | not served, or withdrawn | dropped from routes |
| `400` "only supports Interactions API" | not a chat model | dropped from routes |
| timeout, `5xx` | says nothing | no verdict; retried next run |

This is only sound on a key with no billing enabled, which is why it is opt-in
per provider: with billing on, a served request proves the model runs, not that
it was free.

Each verdict is cached in the state file, so a model costs one probe ever rather
than one per run, and `evaluation.maxPerRun` caps a single run. A "not free"
verdict expires after `discovery.verdictRetryMs` (defaulting to the discovery
interval) so a provider blip cannot retire a model permanently; a "free" verdict
does not expire, because ordinary traffic revisits it and a later refusal
replaces it.

Verdicts outrank `freeModels` in both directions. That is the point: an
allowlist in `config.json` is a guess about someone else's pricing, while a
quota figure is that provider stating its own terms.

The candidate list is narrowed before anything is sent. Google's native listing
marks capability in `supportedGenerationMethods`, so embedding, video, and live
audio models are dropped without naming them. Image, speech, music,
transcription, and agent-only models share the `generateContent` method with
ordinary chat models, so `discovery.exclude.modelPatterns` carries those, along
with `-latest` aliases that would double-count one allowance with the concrete
model they resolve to.

### Daily limits the provider reported

`usage.dailyLimits` in `config.json` is a starting guess. When a provider
refuses a request and states the real allowance, that number replaces the
configured one for that model. `/health` marks which is in use: `reported` came
from the provider, `configured` is still the local guess.

The same reply drives the cooldown. A spent daily quota waits until the quota
day rolls over in `usage.timezone` rather than a fixed interval, so the router
neither retries all night for nothing nor idles past the reset. A per-minute
limit uses the `retryDelay` the provider asked for.

### Excluding domain-specific models

A narrow, domain-tuned model aces a generic benchmark and then lands high in
the ranking even though it is a bad default for general traffic. `discovery.exclude`
keeps those out:

- `modelPatterns`: case-insensitive regexes matched against the model ID.
- `textPatterns`: case-insensitive regexes matched against the catalog `name`
  and `description`. This is the more durable check, because a vendor's naming
  suffix changes but the description keeps saying what the model is for.

Two boundaries are deliberate. Anything listed in `config.json` routes is
exempt, so an explicit entry always beats the filter. And exclusion only
removes a model from automatic ranking: it stays in `GET /v1/models` and can
still be called by its exact ID, since naming it is a deliberate choice.

Filtering applies both when building a route and during collection, so a new
pattern takes effect on restart instead of after the next collection.
`/health` lists the current matches under `discovery.excludedModels`.

`evaluation.baselineScores` overrides a score outright, keyed by
`provider:model` or by the bare model ID. It applies to discovered models as
well as configured ones, and takes precedence over the evaluation score, so it
is the way to bury a model whose automatic score you do not trust.

If a routed catalog model becomes paid, disappears, or stops qualifying as a
text chat model, the next catalog check removes it from every effective route
automatically. It remains in `config.json` as ranking history and becomes
active again only if that catalog lists it as free in the future.

Candidates from a `static` provider stay in the ranking as long as they are
listed under `freeModels` and a key is set. On a `static+catalog` provider they
must additionally still appear in the fetched catalog; those that do not are
reported under `discovery.unavailableModels`.

Discovery and evaluation state is stored in `discovered-free-models.json` and
survives service restarts. That file is gitignored.

Configure the schedule and destination route in `config.json`:

```json
"discovery": {
  "enabled": true,
  "provider": "openrouter",
  "intervalMs": 172800000,
  "route": "free-best",
  "stateFile": "discovered-free-models.json",
  "exclude": {
    "modelPatterns": [],
    "textPatterns": [
      "\\b(finance|medicine|legal)[\\s-]*(focused|specific)\\b"
    ]
  },
  "evaluation": {
    "enabled": true,
    "maxTokens": 4000,
    "maxPerRun": 8,
    "usageWeight": 12,
    "usageMinRequests": 20,
    "pinnedModels": [
      "gemini:gemini-3.8-flash",
      "gemini:gemini-3.7-flash",
      "tokenrouter:z-ai/glm-5.3-free",
      "bai:glm-5.3-flash"
    ]
  }
}
```

`/health` reports the last collection time, free models seen, scores, route
priority, and models removed because they are no longer free. Existing route
positions act as baseline score anchors, decreasing by 4 per position from 94
down to a floor of 30.

Evaluation requests are counted in the usage statistics like any other request,
because they consume the same provider quota.

## Request history and daily quota

Every upstream attempt is counted per day and per `provider:model`, so you can
see which models actually served this week's traffic and how close a provider
is to its free daily cap. Counters live in the same `discovered-free-models.json`
state file, are written back at most once every 1.5 seconds, and are pruned to
`usage.retentionDays`.

```bash
./models.sh            # priority list with today / 7d / fail columns
./models.sh --usage    # per-day and per-model history
```

```json
"usage": {
  "retentionDays": 7,
  "timezone": "America/Los_Angeles",
  "dailyLimits": {
    "gemini:gemini-3.8-flash": 20,
    "gemini:gemini-3.5-flash-lite": 200
  }
}
```

- `timezone` decides when the day rolls over. Gemini free-tier request-per-day
  counters reset at midnight Pacific, so keep it at `America/Los_Angeles` even
  if the host runs elsewhere. Omit the field to use the host's local date.
- `dailyLimits` keys are matched as `provider:model`, then bare `model`, then
  `provider:*`. Limits are informational only; the router does not stop sending
  once a limit is reached, because the numbers are hand-maintained.
- The `today` column and `remainingToday` count only quota-consuming attempts.
  Rate limits, 404s, and 403s are excluded because the provider rejected them
  before running the model.
- Failure buckets are `rateLimit`, `timeout`, `serverError`, `empty`,
  `notFound`, `forbidden`, `aborted`, and `other`, which is what makes it
  visible *why* a request fell through to a lower-priority model.

`GET /health` exposes the same data under `usage`, and each route entry carries
its own `usage` block.

## systemd user service

The unit assumes the repo lives at `~/free-router`. If you cloned somewhere
else, edit `WorkingDirectory` and `ExecStart` before enabling it.

```bash
mkdir -p ~/.config/systemd/user
cp free-router.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now free-router
journalctl --user -u free-router -f
```

`./start.sh` also works without systemd.

## Routing behavior

1. Ranks **models** from `free-best`. Pinned models stay first, in config
   order; the rest follow baseline rank and discovery scores.
2. At each model, tries every provider that currently lists it as a free
   text-chat model. The configured provider is first; other listings for the
   same slug follow. Catalog IDs are matched after stripping an org prefix
   and a trailing `:free`, so a later free OpenRouter copy of a Google or
   B.AI model is tried immediately after the original instead of as a
   separate rank.
3. Skips a provider when its API key is missing.
4. Refreshes catalog providers every 15 minutes.
5. Collects newly free catalog text models every `discovery.intervalMs`, evaluates them, and inserts them
   into `free-best` by score. A catalog listing of a model that is already
   ranked is attached to that model instead of being evaluated as a new one.
6. Removes catalog models that are no longer free, available, or text-chat compatible
   from effective routes.
7. Removes models missing capabilities required by the request, such as tools
   or image input.
8. Tries remaining candidates in that unified order.
9. Applies per-provider/model cooldowns after rate limits, timeouts, server failures, and empty
   successful responses.
10. Before sending a request upstream, redacts values of `*_API_KEY` / `*_TOKEN` /
   `*_SECRET` / `*_PASSWORD` from the local environment, and `NAME=...` assignment
   lines for those names. This cannot stop Hermes from reading `.env` locally; it
   only keeps those values out of OpenRouter, TokenRouter, and B.AI payloads.
11. Buffers reasoning-only stream chunks. Nothing is sent to the client until a
   model emits content or a tool call, so an empty model can still be replaced.
12. On Gemini tool-call follow-ups, reattaches `extra_content.google.thought_signature`
   that OpenAI-only clients drop. Cached signatures from the previous Gemini
   response are preferred; otherwise Google's `skip_thought_signature_validator`
   sentinel is used so the request is not a quota-burning 400. If Gemini still
   returns that 400, remaining Gemini models for the same request are skipped.

When a concrete model ID is requested instead of a route alias, the gateway
tries every provider that currently offers that same model. Use
`provider:model` to force a single provider.
