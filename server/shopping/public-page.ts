import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
for (const [address, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.88.99.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24], ["224.0.0.0", 3],
] as const) blocked.addSubnet(address, bits, "ipv4");
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, bits] of [["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20]] as const) {
  blocked.addSubnet(address, bits, "ipv6");
}

export function isPublicAddress(address: string) {
  const version = isIP(address);
  if (version === 4) return !blocked.check(address, "ipv4");
  return version === 6 && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

export type PageRead = { url: string; html: string; ageSeconds: number; date?: string };
const maxPageBytes = 2_000_000;

/** Pin the checked DNS answer to the socket. No proxy, cookies, redirects by the HTTP client, or subresources. */
export async function readPublicPage(
  start: string, validate: (url: string) => string, signal?: AbortSignal,
): Promise<PageRead | null> {
  const timeout = AbortSignal.timeout(5_000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let current = validate(start);
  for (let redirect = 0; redirect <= 3; redirect++) {
    const url = new URL(current);
    const page = await new Promise<PageRead | { redirect: string } | null>((resolve, reject) => {
      const req = request(url, {
        signal: deadline, agent: false,
        headers: { Accept: "text/html", "Cache-Control": "no-cache", "Accept-Encoding": "identity", "User-Agent": "Bell Price Watch" },
        lookup(hostname, options, callback) {
          void lookup(hostname, { all: true }).then(addresses => {
            deadline.throwIfAborted();
            if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
              throw new Error("Listing does not resolve to a public network");
            }
            if (options.all) callback(null, addresses);
            else callback(null, addresses[0].address, addresses[0].family);
          }).catch(error => callback(error, "", 0));
        },
      }, response => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
          response.destroy();
          return resolve({ redirect: response.headers.location });
        }
        if (response.statusCode !== 200 || !/^text\/html(?:;|$)/i.test(response.headers["content-type"] ?? "") ||
            ![undefined, "identity"].includes(response.headers["content-encoding"])) {
          response.destroy();
          return resolve(null);
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxPageBytes) response.destroy(new Error("Merchant response exceeds size limit"));
          else chunks.push(chunk);
        });
        response.on("error", reject);
        response.on("end", () => resolve({
          url: current, html: Buffer.concat(chunks).toString("utf8"),
          ageSeconds: Number(response.headers.age ?? 0), date: response.headers.date,
        }));
      });
      req.on("error", reject);
      req.end();
    });
    if (!page || !("redirect" in page)) return page;
    current = validate(new URL(page.redirect, url).href);
  }
  return null;
}
