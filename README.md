# Free Router

<p align="center">
  <img src="docs/og.png" alt="Free Router architecture: any OpenAI client to a local gateway to pluggable providers" width="100%">
</p>

Local OpenAI-compatible gateway. Point any client at
`http://127.0.0.1:8787/v1` and use `free-best`. It ranks currently free
models across **any OpenAI-compatible provider you configure**, then fails
over when one is rate-limited, down, or empty. A missing key just drops that
provider.

Site: [www222fff.github.io/free-router](https://www222fff.github.io/free-router/)

## Run

Node.js 20+. Copy `.env.example` to `.env`, uncomment at least one provider key
and fill it in, then:

```bash
git clone https://github.com/www222fff/free-router.git
cd free-router
cp .env.example .env
./start.sh
```

Stop with `./stop.sh`. Docker: `docker compose up -d`. Open
<http://127.0.0.1:8787/> to set keys and watch usage.

## Providers

Every provider below is read from a single variable, `<NAME>_API_KEY`, set in
your shell, in `.env`, or on the deploy platform — never in `config.json`. A
missing key just drops that provider; nothing else changes. `config.json`
carries the base URL and the free-model list for each. Every key in the table is
one you copy from the provider in the "Where" column. `FREE_ROUTER_API_KEY`,
under Authentication below, is the opposite: nobody issues it, you invent it.

| Variable | Where | Free access |
| --- | --- | --- |
| `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) | 25+ `:free` models, 50 req/day |
| `GEMINI_API_KEY` | [Google AI Studio](https://aistudio.google.com/apikey) | Standing free tier |
| `TOKENROUTER_API_KEY` | TokenRouter | Free GLM-5.3 |
| `BAI_API_KEY` | [chat.b.ai](https://chat.b.ai) | Limited free models |
| `GROQ_API_KEY` | [console.groq.com/keys](https://console.groq.com/keys) | 30 RPM / 14,400 req/day |
| `CEREBRAS_API_KEY` | [cloud.cerebras.ai](https://cloud.cerebras.ai) | ~1M tokens/day |
| `MISTRAL_API_KEY` | [console.mistral.ai](https://console.mistral.ai/api-keys) | ~1B tokens/month |
| `GITHUB_API_KEY` | [GitHub tokens](https://github.com/settings/tokens) | Free with `models:read` |
| `NVIDIA_API_KEY` | [build.nvidia.com](https://build.nvidia.com) | Credit-based, ~90 models |
| `HUGGINGFACE_API_KEY` | [HF tokens](https://huggingface.co/settings/tokens) | Small standing credit |
| `OVHCLOUD_API_KEY` | [OVHcloud AI Endpoints](https://www.ovhcloud.com/en/public-cloud/ai-endpoints/) | Free tier, EU-hosted |
| `CHUTES_API_KEY` | [chutes.ai](https://chutes.ai) | Free community tier |
| `SAMBANOVA_API_KEY` | [cloud.sambanova.ai](https://cloud.sambanova.ai) | Free tier, no card |
| `OLLAMA_API_KEY` | [ollama.com](https://ollama.com/settings/keys) | Free model families |
| `OPENCODE_API_KEY` | [opencode.ai/zen](https://opencode.ai/zen) | Free registration |
| `KILO_API_KEY` | [kilo.ai](https://kilo.ai) | Free `:free` catalog |
| `NSCALE_API_KEY` | [nscale.com](https://nscale.com) | Free registration tier |
| `DEEPINFRA_API_KEY` | [deepinfra.com](https://deepinfra.com/dash/api_keys) | Free model tier |
| `ZHIPU_API_KEY` | [z.ai](https://z.ai) | GLM-4.7/4.5/4.6V Flash free |
| `MOONSHOT_API_KEY` | [platform.kimi.ai](https://platform.kimi.ai) | Kimi |
| `DEEPSEEK_API_KEY` | [platform.deepseek.com](https://platform.deepseek.com/api_keys) | DeepSeek |
| `QWEN_API_KEY` | [Model Studio](https://modelstudio.console.alibabacloud.com) | Qwen |
| `XAI_API_KEY` | [console.x.ai](https://console.x.ai) | Sign-up credits |
| `SCALEWAY_API_KEY` | [console.scaleway.com](https://console.scaleway.com) | Free credits |
| `AI21_API_KEY` | [studio.ai21.com](https://studio.ai21.com) | Trial credits |
| `NEBIUS_API_KEY` | [studio.nebius.com](https://studio.nebius.com) | Nebius Token Factory |
| `FIREWORKS_API_KEY` | [fireworks.ai](https://fireworks.ai/api-keys) | $1 trial credit |
| `CLOUDFLARE_API_KEY` | [dash.cloudflare.com](https://dash.cloudflare.com) | 10,000 neurons/day |
| `OPENAI_API_KEY` | [platform.openai.com](https://platform.openai.com/api-keys) | Trial credits only |

`CLOUDFLARE_ACCOUNT_ID` is also required for Cloudflare: the account id is part
of the URL (`/accounts/<id>/ai/v1`), not a header, so `config.json`
interpolates it into the base URL. `OPENAI_API_KEY` is wired up but routes
nothing by default, because OpenAI has no standing zero-cost models to rank.

The `freeModels` lists for the newer providers are best-effort seeds, and free
lineups change often. Where a key carries no billing, `probeFreeTier` asks the
provider directly and discovery adds whatever it confirms; check
`/health` for the models a provider is actually serving.

More providers: add a block in `config.json`. See [How it works](docs/HOW_IT_WORKS.md).

## Deploy to SnapDeploy

The Dockerfile and `.env.example` are set up for it. Push this branch, then in
the dashboard choose **Deploy from GitHub** and pick the repo.

1. SnapDeploy detects the Dockerfile and builds the image.
2. It scans the repo and shows an **Environment Variables Detected** screen.
   Every variable listed there is tagged Required, so `.env.example` declares
   exactly one as a real `NAME=` line — `FREE_ROUTER_API_KEY`, the value a
   public deployment cannot do without. The 29 provider keys above, plus
   Cloudflare's account id, are commented out and never appear — which is what
   lets you deploy with no provider key at all and add them as you get them.
3. Enter the token — `openssl rand -hex 32` is enough — and click **Deploy**.
4. Add provider keys on the same screen with **+ Add Variable**, or afterwards
   under **Container Settings → Environment Variables**; either way the name is
   what matters, so copy it from the table above. SnapDeploy rolls the container
   so a new value takes effect. Names ending in `_KEY` or `_TOKEN` get a Secret
   badge and are masked.
5. `PORT` is assigned and locked by SnapDeploy; `server.mjs` falls back to it,
   and the image binds `0.0.0.0` so the platform proxy can reach it.

A key saved through the web interface is written to `.env` inside the container,
so it survives a restart but not a rebuild. On a deployed instance, keep
SnapDeploy's variables as the durable store and treat the dashboard as a
temporary override.

## Authentication

Set `FREE_ROUTER_API_KEY` before exposing the router to anything but loopback.
It is a shared secret that callers send as `Authorization: Bearer <token>`.

There is nowhere to get it: it is not issued by a provider, has no signup page,
and grants nothing outside your own gateway. Make it up.

```bash
openssl rand -hex 32    # or: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Hex is the point, not just the length. There is no format rule — the app takes
whatever non-empty string you set — but `start.sh` loads `.env` by sourcing it in
a shell, so a value containing spaces, `$`, backticks, or quotes is expanded or
executed by the shell instead of read as a secret. A word you invent is also
guessable by whoever is scanning the public port, and memorability buys you
nothing here: the value is pasted once into the deploy screen and once into each
client, never typed.

Paste that value into `.env` for a local run, or into the one Required field on
SnapDeploy's deploy screen (Container Settings → Environment Variables later,
which rolls the container). Every client then sends the same string as its API
key: OpenAI SDKs are pointed at `https://your-host/v1` with `api_key` set to it,
and curl uses the header shown below. It is read once at startup, so changing it
needs a restart. Give each client the same value, or rotate it to revoke one.

Without it, `/v1/chat/completions` spends your upstream quota for anyone who
can reach the port and `/health` publishes every base URL and free-model list.
That is invisible locally, because `127.0.0.1` means only you — and it stops
being true the moment a container platform routes public traffic to you.

Setting it does two things: it makes `/v1/*` and `/health` require the token,
and it lets an authenticated caller reach the web interface from off loopback,
which is otherwise blocked by the loopback guard. Leaving it unset keeps the
original loopback-only behaviour for local runs.

```bash
curl https://your-app.containers.snapdeploy.app/v1/chat/completions \
  -H "Authorization: Bearer $FREE_ROUTER_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"free-best","messages":[{"role":"user","content":"hi"}]}'
```

Note that any browser page you visit can POST to `127.0.0.1:8787` — the
`text/plain` content type avoids a CORS preflight and the body is still parsed
as JSON. Setting a token closes that too.


```bash
./models.sh          # current free-best order
./models.sh --usage  # today's quota
```

## Star History

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=www222fff/free-router&type=Date&theme=dark" />
  <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=www222fff/free-router&type=Date" />
  <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=www222fff/free-router&type=Date" />
</picture>
