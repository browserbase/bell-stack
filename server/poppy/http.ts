import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";

const MAX_BYTES = 1024 * 1024;
const MAX_COOLDOWNS = 1024;
// Endpoint/method scoped and process local: never put access tokens or query strings in this cache.
const cooldowns = new Map<string, number>();

export class PoppyRateLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) {
    super(`Poppy endpoint is rate limited. Retry in ${retryAfterSeconds} seconds.`);
    this.name = "PoppyRateLimitError";
  }
}

function endpointKey(url: URL, method = "GET"): string {
  return createHash("sha256").update(`${method.toUpperCase()} ${url.origin}${url.pathname}`).digest("hex");
}
function checkCooldown(url: URL, method?: string): void {
  const now = Date.now();
  for (const [key, until] of cooldowns) if (until <= now) cooldowns.delete(key);
  const until = cooldowns.get(endpointKey(url, method));
  if (until !== undefined) throw new PoppyRateLimitError(Math.ceil((until - now) / 1000));
}
export function poppyRetryAfterSeconds(headers: Headers, now = Date.now()): number | undefined {
  const value = headers.get("retry-after")?.trim();
  if (!value) return;
  let until: number;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds)) return;
    until = now + seconds * 1000;
  } else {
    // IMF-fixdate plus the two obsolete HTTP-date forms accepted by RFC 9110.
    const day = "(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)", month = "(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
    const modern = new RegExp(String.raw`^${day}, \d{2} ${month} \d{4} \d{2}:\d{2}:\d{2} GMT$`);
    const obsolete = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-[A-Za-z]{3}-\d{2} \d{2}:\d{2}:\d{2} GMT$/;
    const asctime = new RegExp(String.raw`^${day} ${month} [ \d]\d \d{2}:\d{2}:\d{2} \d{4}$`);
    if (!modern.test(value) && !obsolete.test(value) && !asctime.test(value)) return;
    until = Date.parse(asctime.test(value) ? `${value} GMT` : value);
  }
  return Number.isFinite(until) ? Math.max(0, Math.ceil((until - now) / 1000)) : undefined;
}
function rememberCooldown(url: URL, method: string | undefined, status: number | undefined, headers: Headers): void {
  if (status !== 429) return;
  const now = Date.now();
  const seconds = poppyRetryAfterSeconds(headers, now);
  if (seconds === undefined || seconds <= 0) return;
  let until = now + seconds * 1000;
  for (const [key, expiry] of cooldowns) if (expiry <= now) cooldowns.delete(key);
  const key = endpointKey(url, method);
  until = Math.max(until, cooldowns.get(key) ?? 0);
  cooldowns.delete(key);
  // Retain the most recently encountered limits without unbounded process memory.
  if (cooldowns.size >= MAX_COOLDOWNS) cooldowns.delete(cooldowns.keys().next().value!);
  cooldowns.set(key, until);
}
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const)
  blocked.addSubnet(address, prefix, "ipv6");
const globalIPv6 = new BlockList();
globalIPv6.addSubnet("2000::", 3, "ipv6");

/** Accept only publicly routable addresses, including after DNS resolution. */
export function isPublicPoppyAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  // This also excludes mapped IPv4, transition networks, local and multicast addresses.
  return family === 6 && globalIPv6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

export function publicPoppyUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("Poppy requires a public HTTPS URL."); }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash ||
    !hostname || hostname.endsWith(".") || /(^|\.)(localhost|local|internal|lan|home|test|invalid)$/.test(hostname) ||
    (isIP(hostname) ? !isPublicPoppyAddress(hostname) : !hostname.includes(".")))
    throw new Error("Poppy requires a public HTTPS URL.");
  return url;
}

export type PoppyRequestOptions = {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
  discoveryRedirects?: boolean;
  until?: (text: string, headers: Headers) => boolean;
};
export type PoppyResponse = { status: number; headers: Headers; text: string; url: string };

function requestError(signal: AbortSignal): Error {
  if (signal.aborted) return new DOMException("Poppy request interrupted.", signal.reason?.name === "TimeoutError" ? "TimeoutError" : "AbortError");
  return new Error("Poppy request failed.");
}

async function publicAddress(hostname: string, signal: AbortSignal) {
  if (signal.aborted) throw requestError(signal);
  if (isIP(hostname)) return { address: hostname, family: isIP(hostname) };
  return new Promise<{ address: string; family: number }>((resolve, reject) => {
    const onAbort = () => reject(requestError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    lookup(hostname, { all: true, verbatim: true }).then(addresses => {
      if (!addresses.length || addresses.some(({ address }) => !isPublicPoppyAddress(address)))
        reject(new Error("Poppy destination is not public."));
      else resolve(addresses[0]);
    }, () => reject(requestError(signal))).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function requestOnce(url: URL, options: PoppyRequestOptions, signal: AbortSignal): Promise<PoppyResponse> {
  const pinned = await publicAddress(url.hostname.replace(/^\[|\]$/g, ""), signal);
  if (signal.aborted) throw requestError(signal);
  checkCooldown(url, options.method);
  return new Promise((resolve, reject) => {
    try {
      const req = httpsRequest(url, {
        method: options.method ?? "GET", headers: { accept: "application/json", "accept-encoding": "identity", "user-agent": "Bell/0.1 (Poppy client)", ...options.headers },
        signal, agent: false, maxHeaderSize: 16 * 1024,
        // The socket must use the address we checked; a second DNS lookup would permit rebinding.
        lookup: (_host, opts, callback) => {
          if (opts.all) callback(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        },
      }, response => {
        const headers = new Headers();
        for (const [name, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) for (const entry of value) headers.append(name, entry);
          else if (value !== undefined) headers.set(name, value);
        }
        rememberCooldown(url, options.method, response.statusCode, headers);
        let bytes = 0;
        const chunks: Buffer[] = [];
        const result = () => ({ status: response.statusCode ?? 0, headers, text: Buffer.concat(chunks).toString("utf8"), url: url.href });
        const tooLarge = () => {
          reject(new Error("Poppy response exceeds the 1 MiB limit."));
          response.destroy();
          req.destroy();
        };
        if (Number(headers.get("content-length")) > MAX_BYTES) { tooLarge(); return; }
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_BYTES) tooLarge();
          else {
            chunks.push(chunk);
            if (options.until) {
              try {
                const current = result();
                if (options.until(current.text, headers)) { resolve(current); response.destroy(); req.destroy(); }
              } catch { reject(requestError(signal)); response.destroy(); req.destroy(); }
            }
          }
        });
        response.once("error", () => reject(requestError(signal)));
        response.once("aborted", () => reject(requestError(signal)));
        response.once("end", () => resolve(result()));
      });
      req.once("error", () => reject(requestError(signal)));
      req.end(options.body);
    } catch { reject(requestError(signal)); }
  });
}

export async function requestPoppy(value: string, options: PoppyRequestOptions = {}): Promise<PoppyResponse> {
  let url = publicPoppyUrl(value);
  // Only discovery may redirect, and discovery requests never contain credentials or a body.
  if (options.discoveryRedirects && ((options.method ?? "GET") !== "GET" || options.body !== undefined ||
    Object.keys(options.headers ?? {}).some(name => name.toLowerCase() !== "accept")))
    throw new Error("Poppy discovery redirects require a credential-free GET.");
  const deadline = AbortSignal.timeout(15_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  for (let redirects = 0; ; redirects++) {
    if (signal.aborted) throw requestError(signal);
    checkCooldown(url, options.method);
    const response = await requestOnce(url, options, signal);
    if (![301, 302, 303, 307, 308].includes(response.status) || !options.discoveryRedirects) return response;
    const location = response.headers.get("location");
    if (!location || redirects >= 3) throw new Error("Poppy discovery redirect failed.");
    try { url = publicPoppyUrl(new URL(location, url).href); }
    catch { throw new Error("Poppy discovery redirect is not a public HTTPS URL."); }
  }
}
