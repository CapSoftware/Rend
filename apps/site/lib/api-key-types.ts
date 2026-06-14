export const API_KEY_SCOPES = ["upload", "read", "delete", "analytics"] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export type ApiKeyRecord = {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiKeyScope[];
  created_at: string;
  revoked_at?: string;
  last_used_at?: string;
};
