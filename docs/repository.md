# Standalone Bell repository

Bell lives in [browserbase/bell-stack](https://github.com/browserbase/bell-stack).
Its application files sit at the repository root:

```text
agent/                  Eve agent, Linq channel, shared tool imports
app/                    Web interface and human handoff routes
server/                 Baselayer minting and one-request merchant proof
scripts/                Standalone mint command
tests/                  Browser interface, Linq, and merchant-access tests
docs/                   Setup and demo guides
vendor/cookbook/         Git submodule containing the shared Browsie package
.env.example            Server configuration template
package.json            Bell dependencies and commands
pnpm-lock.yaml          Reproducible Bell dependency resolution
```

The submodule points at Cookbook commit `bcda925b87a42e5100b122739a6446662964992e`, which exports
the shared runtime in draft PR #27. This preserves the existing tested browser tools, vault
integration, Contexts, and handoff without copying Browsie's web application into Bell. GitHub
shows the dependency as a link to that commit, not thousands of added source files.

Cloning with `--recurse-submodules` downloads the dependency repository. `pnpm setup:runtime`
also initializes it when omitted during cloning. The shared runtime still needs to be built before
Bell's `file:` dependency is installed. The submodule and generated dependency files are excluded
from Bell's lint and TypeScript source discovery; imported runtime types are still checked.

Bell can be versioned and deployed independently. It still depends on the pinned Browsie source.
A future published Browsie package could replace the submodule without changing Bell's imports.
Until then, changing that dependency is an explicit Git submodule update followed by setup,
installation, tests, typecheck, lint, and build. Do not update it automatically to Cookbook main.

This stage adds Baselayer minting and merchant access to the browser assistant, web interface,
and signed Linq messaging channel. The merchant verifier remains a separate deployment. Linq
uses the same agent tools in a separate conversation for each phone chat. Stripe Link CLI and
Visa checkout remain follow-up integrations.

The original Cookbook drafts remain separate from this repository. Keep the shared-runtime change
in Cookbook. Once Bell's standalone draft is published, the Bell app and merchant-access drafts
in Cookbook can be closed as superseded. No history needs to be force-pushed or deleted.
