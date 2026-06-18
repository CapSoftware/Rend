import { eq } from "drizzle-orm";
import { member, organization, user } from "./db/schema.ts";
import { getSiteDb } from "./server-db.ts";

export const LOCAL_ORG_ID = "00000000-0000-0000-0000-000000000001";
export const LOCAL_ADMIN_USER_ID = "00000000-0000-0000-0000-000000000010";

let seedPromise: Promise<void> | null = null;

function envString(name: string, fallback = "") {
  return (process.env[name] || fallback).trim();
}

function isProductionProfile() {
  const profile = envString("REND_ENV_PROFILE") || envString("REND_ENV") || process.env.NODE_ENV || "local";
  return ["production", "prod"].includes(profile.toLowerCase());
}

export function localAdminEmail() {
  return envString("REND_LOCAL_ADMIN_EMAIL", "admin@rend.test").toLowerCase();
}

async function seedLocalAuthOnce() {
  if (isProductionProfile()) return;

  const db = getSiteDb();
  const now = new Date();
  const email = localAdminEmail();

  const [seedUser] = await db
    .insert(user)
    .values({
      id: LOCAL_ADMIN_USER_ID,
      name: "Rend Local Admin",
      email,
      email_verified: true,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: user.id,
      set: {
        name: "Rend Local Admin",
        email,
        email_verified: true,
        updated_at: now,
      },
    })
    .returning({ id: user.id });

  const seededMetadata = {
    seeded: "local",
    onboarding: { completed_at: now.toISOString(), source: "local_seed" },
  };

  await db
    .insert(organization)
    .values({
      id: LOCAL_ORG_ID,
      name: "Rend Local",
      slug: "local",
      metadata: seededMetadata,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: organization.id,
      set: {
        name: "Rend Local",
        slug: "local",
        metadata: seededMetadata,
        updated_at: now,
      },
    });

  await db
    .insert(member)
    .values({
      organization_id: LOCAL_ORG_ID,
      user_id: seedUser?.id ?? LOCAL_ADMIN_USER_ID,
      role: "owner",
      created_at: now,
    })
    .onConflictDoUpdate({
      target: [member.user_id, member.organization_id],
      set: { role: "owner" },
    });

  await db
    .update(user)
    .set({ updated_at: now })
    .where(eq(user.email, email));
}

export function ensureLocalAuthSeed() {
  seedPromise ??= seedLocalAuthOnce().catch((error) => {
    seedPromise = null;
    throw error;
  });
  return seedPromise;
}
