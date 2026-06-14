import spec from "../../../../docs/openapi/rend-public-api.openapi.json";

export const dynamic = "force-static";

export function GET() {
  return Response.json(spec, {
    headers: {
      "cache-control": "public, max-age=3600",
    },
  });
}
