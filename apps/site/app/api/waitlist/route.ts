export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const email =
    typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return Response.json(
      { error: "Please enter a valid email address" },
      { status: 400 }
    );
  }

  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    return Response.json(
      { error: "Waitlist storage is not configured" },
      { status: 500 }
    );
  }

  const response = await fetch(`${url}/sadd/waitlist/${encodeURIComponent(email)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    return Response.json(
      { error: "Could not save your email, please try again" },
      { status: 502 }
    );
  }

  return Response.json({ ok: true });
}
