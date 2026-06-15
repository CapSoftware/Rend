import { getPublicPricing, PRICING_REVALIDATE_SECONDS } from "@/lib/pricing";

// Cached public pricing, refreshed from Autumn at most once per hour.
export const revalidate = 3600;

export async function GET() {
  const pricing = await getPublicPricing();
  return Response.json(pricing, {
    headers: {
      "cache-control": `public, max-age=0, s-maxage=${PRICING_REVALIDATE_SECONDS}, stale-while-revalidate=86400`,
    },
  });
}
