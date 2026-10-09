# Bell-Stack

**Ring the BELL and put your personal assistant to work.** Bell pairs an Eve agent with browser
automation powered by Browserbase and a compact web interface. This standalone repository owns
Bell's agent, interface, and configuration.
The pinned `browsie` package supplies Stagehand/Browserbase session management, browser tools,
Contexts, human handoff, and optional 1Password access.

## Run locally

Use Node.js 24 and pnpm 10.33.4. Clone Bell and initialize its shared runtime:

```sh
git clone --recurse-submodules https://github.com/browserbase/bell-stack.git
cd bell-stack
pnpm setup:runtime
pnpm install --frozen-lockfile
cp .env.example .env
# Set OPENAI_API_KEY and BROWSERBASE_API_KEY in .env.
pnpm dev
```

Open `http://127.0.0.1:4320` and select **Open demo site**. Bell opens the configured `BELL_DEMO_URL`
in one persistent Browserbase session. Ask for a screenshot to update the capture panel. Follow-up
messages at the same `/s/...` address reuse the conversation and browser. Stop cancels active work.
The panel is a screenshot viewer; use `human_handoff` when you need to interact with the browser.

The `browsie` dependency comes from `vendor/cookbook/projects/browsie`. Git tracks that submodule
as one commit pointer, so Bell does not contain a second copy of Browsie's source in its history.
`pnpm setup:runtime` checks out the pinned revision, installs that package's dependencies, and
builds its shared exports. Run it again after updating the submodule, before reinstalling Bell.
Bell calls the runtime in the same process, with one Eve runtime and one browser per conversation.
Keep Eve versions aligned across both packages. The lockfile is generated dependency data.

The initial runtime pin is Cookbook commit `bcda925b87a42e5100b122739a6446662964992e`,
from [the shared-runtime draft PR](https://github.com/browserbase/cookbook/pull/27).
The dependency is pinned to that commit, not a moving branch. See
[the repository layout and dependency notes](docs/repository.md).

## Optional integrations

- 1Password: for local desktop access, set `OP_ACCOUNT="Your account name"` in `.env.local`,
  using the account name shown in the 1Password sidebar. In the desktop app, enable
  **Settings > Developer > Integrate with other apps** under the SDK options, then approve
  the request when prompted. Bell must run on the same computer as the desktop app.
  For hosted access, set `OP_SERVICE_ACCOUNT_TOKEN` instead; it takes precedence over `OP_ACCOUNT`.
  Save a Login item with the destination website, username, and password before asking Bell to log in.
  Add a one-time password field if the site uses TOTP. The shared vault tools enforce the saved
  website host and resolve credentials on the server. A URL alone does not provide a login.
- Handoff: set a random `BROWSIE_HANDOFF_SECRET` of at least 32 characters and
  `BROWSIE_PUBLIC_URL` to the app's reachable origin. Configure this before asking for a handoff.

The shared runtime retains its `BROWSIE_*` configuration names. Bell does not copy the Context or
Vault administration screens. Their agent tools remain available. Stripe Link CLI and Visa
checkout are follow-up integrations; this project does not yet submit payments.

## Check the code

```sh
pnpm test
pnpm typecheck
pnpm lint
pnpm build
```

The default suite makes no live provider calls. A successful build verifies compilation only.
Keep this demo local until you configure application authentication and durable storage. Eve's
default HTTP channel rejects unauthenticated production traffic. The shared vault/Context data
uses local files and is scoped to a single demo operator. See
[`vendor/cookbook/projects/browsie/README.md`](vendor/cookbook/projects/browsie/README.md) for runtime
settings and [the vault guide](vendor/cookbook/projects/browsie/docs/vault-and-otp.md) for the credential boundary.
