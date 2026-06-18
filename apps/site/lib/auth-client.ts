"use client";

import { createAuthClient } from "better-auth/react";
import { emailOTPClient, organizationClient } from "better-auth/client/plugins";
import { clearDashboardAuthHintCookieHeader } from "./dashboard-auth-hint";

export const authClient = createAuthClient({
  plugins: [emailOTPClient(), organizationClient()],
});

export async function signOutOfDashboard() {
  const result = await authClient.signOut();
  if (result.error) {
    throw new Error(result.error.message || "Sign out failed");
  }
  document.cookie = clearDashboardAuthHintCookieHeader({ secure: window.location.protocol === "https:" });
  window.location.assign("/login");
}
