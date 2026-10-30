# Public-web research with Parallel

Set `PARALLEL_API_KEY` in the server's ignored `.env.local` and restart Bell. Use a key from
the BELL app in your Parallel workspace; configure its monthly budget there. Set the same
server-only variable in each deployment environment. No additional package is required.
Without a key, research tools return a configuration error; browser tools remain available.

`web_search` calls [Parallel Search](https://docs.parallel.ai/search/search-quickstart) at
`/v1/search` in `fast` mode with 1–3 keyword queries and an objective. It returns five results
by default, up to ten. `web_fetch` calls [Parallel Extract](https://docs.parallel.ai/extract/extract-quickstart)
at `/v1/extract` for up to five public URLs with an objective. Advanced options are nested
under `advanced_settings`. These tools run on the server and share no browser state with Parallel.

Each request has a 30-second deadline and follows Eve turn cancellation. Responses exceeding
1 MiB are cancelled before JSON parsing. There are no automatic
retries or API redirects. Source URLs, titles, publication dates, and excerpts are retained;
excerpts are capped at 2,000 characters per search result or 6,000 per extracted page, and
16,000 per call. Local caps apply even if the provider exceeds the requested limits.
The result reports truncation, provider warning count, and per-URL extraction errors.
Raw provider error bodies, warning details, and authentication headers are never returned.

Use Parallel for public evidence; cite source URLs and check incomplete results. Retrieval
time is not a freshness guarantee. Use Browserbase for live availability, authentication,
forms, and actions, under Bell's existing credential and payment rules. The URL validator
rejects IP literals, credentials, common authentication/signature query parameters,
custom ports, and obvious local/internal hostnames. Fragments are removed before transmission
and from source URLs; public query strings remain supported.
It cannot identify every private URL or secret in a path or query: never include those URLs or private data
in research inputs. The provider may fetch source pages; this is not a cache-only integration.

Run `pnpm check` for credential-free regression checks. See [provider checks](provider-tests.md)
for the opt-in live research-to-browser test. Task API and background research are outside
this integration.
