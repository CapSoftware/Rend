import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ONBOARDING_NAME_LENGTH,
  onboardingCompletedFromMetadata,
  sanitizeOnboardingText,
} from "./onboarding.ts";

test("onboarding completion is detected from organization metadata", () => {
  assert.equal(
    onboardingCompletedFromMetadata({ onboarding: { completed_at: "2026-06-18T10:00:00.000Z" } }),
    true
  );
  assert.equal(onboardingCompletedFromMetadata({ onboarding: { completed_at: "" } }), false);
  assert.equal(onboardingCompletedFromMetadata({ onboarding: { completed_at: "   " } }), false);
  assert.equal(onboardingCompletedFromMetadata({ provisioned: "email-otp-signup" }), false);
  assert.equal(onboardingCompletedFromMetadata({}), false);
  assert.equal(onboardingCompletedFromMetadata(null), false);
  assert.equal(onboardingCompletedFromMetadata("not-an-object"), false);
});

test("onboarding text is trimmed, whitespace-collapsed, and length capped", () => {
  assert.equal(sanitizeOnboardingText("  Ada   Lovelace  ", MAX_ONBOARDING_NAME_LENGTH), "Ada Lovelace");
  assert.equal(sanitizeOnboardingText("Acme\nInc", MAX_ONBOARDING_NAME_LENGTH), "Acme Inc");
  assert.equal(sanitizeOnboardingText("", MAX_ONBOARDING_NAME_LENGTH), "");
  assert.equal(sanitizeOnboardingText("   ", MAX_ONBOARDING_NAME_LENGTH), "");
  assert.equal(sanitizeOnboardingText(undefined, MAX_ONBOARDING_NAME_LENGTH), "");
  assert.equal(sanitizeOnboardingText(42, MAX_ONBOARDING_NAME_LENGTH), "");
  assert.equal(sanitizeOnboardingText("x".repeat(120), 80).length, 80);
});
