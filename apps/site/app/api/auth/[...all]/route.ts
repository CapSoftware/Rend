import { toNextJsHandler } from "better-auth/next-js";
import { ensureLocalAuthSeed } from "../../../../lib/auth-seed.ts";
import { getAuth } from "../../../../lib/auth.ts";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function handler(request: Request) {
  await ensureLocalAuthSeed();
  const auth = getAuth() as { handler: (request: Request) => Response | Promise<Response> };
  return auth.handler(request);
}

export const { GET, POST } = toNextJsHandler(handler);
