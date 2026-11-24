import { z } from "zod";
import { required } from "../monitors/config";
import { request } from "../monitors/provider";
import { listingUrl } from "./evidence";

const lead = z.object({ url: z.string().max(2048) });
const response = z.object({
  results: z.array(lead.extend({ offers: z.array(lead).default([]) })),
});

export async function discoverListings(query: string, country: string, currency: string, signal?: AbortSignal) {
  const shopping = response.parse(await request("https://api.parallel.ai/v1/shopping/search", required("PARALLEL_API_KEY"), "POST", {
    mode: "advanced", search_queries: [`${query.slice(0, 175)} ${country} ${currency}`], condition: "any",
    advanced_settings: { location: country.toLowerCase(), max_results: 8 },
  }, false, signal));

  const candidates = shopping.results.flatMap(item => [item.url, ...item.offers.slice(0, 3).map(offer => offer.url)]);
  return [...new Set(candidates.flatMap(candidate => {
    const url = listingUrl.safeParse(candidate);
    return url.success ? [url.data] : [];
  }))].slice(0, 5);
}
