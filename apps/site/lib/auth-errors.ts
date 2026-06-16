export type AuthErrorContext = "otp_request" | "otp_verification" | "auth";

function payloadMessage(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  const record = payload as Record<string, unknown>;
  for (const key of ["message", "error_description", "error"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function genericProviderMessage(message: string) {
  return /internal server error|something went wrong|failed to fetch|unable to fetch/i.test(message);
}

export function authRequestTimedOutMessage(context: AuthErrorContext) {
  if (context === "otp_request") {
    return "Rend could not confirm email delivery in time. Try again in a minute and use the newest code that arrives.";
  }
  if (context === "otp_verification") {
    return "Rend could not verify the code in time. Try again, or request a new code if it has expired.";
  }
  return "The auth request timed out. Try again shortly.";
}

export function authFailureMessage(input: {
  status?: number;
  payload?: unknown;
  fallback: string;
  context?: AuthErrorContext;
}) {
  const status = input.status ?? 0;
  const context = input.context ?? "auth";
  const message = payloadMessage(input.payload);

  if (status === 408 || status === 504) return authRequestTimedOutMessage(context);
  if (status === 429) return "Too many sign-in attempts. Wait a minute, then try again.";
  if (context === "otp_request" && status >= 500) {
    return "Rend could not send the sign-in email. Try again shortly; if it keeps failing, contact support.";
  }
  if (context === "otp_verification" && (status === 400 || status === 401 || status === 403)) {
    return "Invalid or expired sign-in code. Request a new code if needed.";
  }
  if (message && !genericProviderMessage(message)) return message;
  return input.fallback;
}
