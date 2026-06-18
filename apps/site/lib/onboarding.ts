import { eq } from "drizzle-orm";
import { organization, user } from "./db/schema.ts";
import { getSiteDb } from "./server-db.ts";

export const ONBOARDING_PATH = "/onboarding";
export const MAX_ONBOARDING_NAME_LENGTH = 80;
export const MAX_ONBOARDING_ORGANIZATION_NAME_LENGTH = 80;
export const MAX_ONBOARDING_PLAN_ID_LENGTH = 128;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function sanitizeOnboardingText(value: unknown, maxLength: number): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function onboardingCompletedFromMetadata(metadata: unknown): boolean {
  const onboarding = asRecord(asRecord(metadata).onboarding);
  return typeof onboarding.completed_at === "string" && onboarding.completed_at.trim().length > 0;
}

export async function organizationOnboardingComplete(organizationId: string): Promise<boolean> {
  const db = getSiteDb();
  const [row] = await db
    .select({ metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);
  return row ? onboardingCompletedFromMetadata(row.metadata) : false;
}

export type CompleteOnboardingInput = {
  userId: string;
  organizationId: string;
  name: string;
  organizationName: string;
  planId?: string | null;
};

export async function completeOnboarding(input: CompleteOnboardingInput): Promise<void> {
  const db = getSiteDb();
  const now = new Date();

  await db
    .update(user)
    .set({ name: input.name, updated_at: now })
    .where(eq(user.id, input.userId));

  const [row] = await db
    .select({ metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.id, input.organizationId))
    .limit(1);

  const existing = asRecord(row?.metadata);
  const metadata = {
    ...existing,
    onboarding: {
      ...asRecord(existing.onboarding),
      completed_at: now.toISOString(),
      plan_id: input.planId ?? null,
    },
  };

  await db
    .update(organization)
    .set({ name: input.organizationName, metadata, updated_at: now })
    .where(eq(organization.id, input.organizationId));
}
