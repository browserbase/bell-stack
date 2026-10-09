# Bell-Stack

Bell is a standalone repository with a pinned Browsie runtime dependency.
Keep Bell-specific tools and configuration here; import the shared browser runtime through
`browsie/runtime`. `vendor/cookbook` is a Git submodule, not copied application source.
Do not edit the dependency or move its commit without separately reviewing and testing the change.
Do not copy the Browsie application or start a second browser-control service.

Do not commit or push code. Give the user the commands instead.
Use shriyatheunicorn <shriavj@gmail.com> for Git authorship and committer identity.
Never add AI co-author trailers or signatures. Do not use em dashes in writing.

Use Node.js 24 and pnpm 10.33.4. Run pnpm setup:runtime before installing Bell's dependencies.
Run test, typecheck, lint, and build before proposing a PR.
Do not commit secrets or expose credentials in tool outputs, prompts, or logs.
Keep tests with their implementation. Document which live services were actually tested.
