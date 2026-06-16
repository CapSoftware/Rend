import { relations, sql } from "drizzle-orm";
import {
  boolean,
  bigint,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const rendAuth = pgSchema("rend_auth");
export const rend = pgSchema("rend");

function createdAt() {
  return timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
}

function updatedAt() {
  return timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();
}

export const user = rendAuth.table(
  "user",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    email_verified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [uniqueIndex("user_email_uidx").on(table.email)]
);

export const organization = rendAuth.table(
  "organization",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    logo: text("logo"),
    metadata: jsonb("metadata"),
    suspended_at: timestamp("suspended_at", { withTimezone: true }),
    suspended_by_user_id: uuid("suspended_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    suspension_reason: text("suspension_reason"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [uniqueIndex("organization_slug_uidx").on(table.slug)]
);

export const session = rendAuth.table(
  "session",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
    ip_address: text("ip_address"),
    user_agent: text("user_agent"),
    user_id: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    active_organization_id: uuid("active_organization_id").references(() => organization.id, {
      onDelete: "set null",
    }),
  },
  (table) => [
    uniqueIndex("session_token_uidx").on(table.token),
    index("session_user_id_idx").on(table.user_id),
    index("session_expires_at_idx").on(table.expires_at),
  ]
);

export const account = rendAuth.table(
  "account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    account_id: text("account_id").notNull(),
    provider_id: text("provider_id").notNull(),
    user_id: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    access_token: text("access_token"),
    refresh_token: text("refresh_token"),
    id_token: text("id_token"),
    access_token_expires_at: timestamp("access_token_expires_at", { withTimezone: true }),
    refresh_token_expires_at: timestamp("refresh_token_expires_at", { withTimezone: true }),
    scope: text("scope"),
    password: text("password"),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    index("account_user_id_idx").on(table.user_id),
    index("account_provider_account_idx").on(table.provider_id, table.account_id),
  ]
);

export const verification = rendAuth.table(
  "verification",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    uniqueIndex("verification_identifier_idx").on(table.identifier),
    index("verification_expires_at_idx").on(table.expires_at),
  ]
);

export const rateLimit = rendAuth.table("rate_limit", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  last_request: bigint("last_request", { mode: "number" }).notNull(),
});

export const member = rendAuth.table(
  "member",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    user_id: uuid("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    created_at: createdAt(),
  },
  (table) => [
    uniqueIndex("member_user_org_uidx").on(table.user_id, table.organization_id),
    index("member_user_id_idx").on(table.user_id),
    index("member_organization_id_idx").on(table.organization_id),
  ]
);

export const invitation = rendAuth.table(
  "invitation",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: text("role").notNull(),
    status: text("status").notNull().default("pending"),
    expires_at: timestamp("expires_at", { withTimezone: true }).notNull(),
    inviter_id: uuid("inviter_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    created_at: createdAt(),
  },
  (table) => [
    index("invitation_email_idx").on(table.email),
    index("invitation_organization_status_idx").on(table.organization_id, table.status),
  ]
);

export const assets = rend.table("assets", {
  id: uuid("id").primaryKey(),
  organization_id: uuid("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "restrict" }),
  source_state: text("source_state").notNull(),
  playable_state: text("playable_state").notNull(),
  duration_ms: bigint("duration_ms", { mode: "number" }),
  source_width: integer("source_width"),
  source_height: integer("source_height"),
  source_resolution_tier: text("source_resolution_tier"),
  max_resolution_tier: text("max_resolution_tier"),
  created_at: timestamp("created_at", { withTimezone: true }).notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull(),
  deleted_at: timestamp("deleted_at", { withTimezone: true }),
  suspended_at: timestamp("suspended_at", { withTimezone: true }),
  suspended_by_user_id: uuid("suspended_by_user_id").references(() => user.id, {
    onDelete: "set null",
  }),
  suspension_reason: text("suspension_reason"),
});

export const apiKeys = rend.table(
  "api_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    key_hash: text("key_hash").notNull(),
    scopes: text("scopes").array().notNull(),
    created_by_user_id: uuid("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    revoked_at: timestamp("revoked_at", { withTimezone: true }),
    last_used_at: timestamp("last_used_at", { withTimezone: true }),
    last_used_update_after: timestamp("last_used_update_after", { withTimezone: true }),
  },
  (table) => [
    uniqueIndex("api_keys_key_hash_uidx").on(table.key_hash),
    index("api_keys_organization_revoked_idx").on(table.organization_id, table.revoked_at),
  ]
);

export const operatorAuditRecords = rend.table(
  "operator_audit_records",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    operator_user_id: uuid("operator_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    operator_email: text("operator_email").notNull(),
    action: text("action").notNull(),
    target_type: text("target_type").notNull(),
    target_id: uuid("target_id").notNull(),
    reason: text("reason").notNull(),
    before_state: jsonb("before_state").notNull(),
    after_state: jsonb("after_state").notNull(),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("operator_audit_target_idx").on(table.target_type, table.target_id, table.created_at),
    index("operator_audit_created_idx").on(table.created_at),
  ]
);

export const billingCustomers = rend.table(
  "billing_customers",
  {
    organization_id: uuid("organization_id")
      .primaryKey()
      .references(() => organization.id, { onDelete: "cascade" }),
    autumn_customer_id: text("autumn_customer_id").notNull(),
    billing_mode: text("billing_mode").notNull().default("local"),
    customer_synced_at: timestamp("customer_synced_at", { withTimezone: true }),
    customer_sync_error: text("customer_sync_error"),
    billing_state: jsonb("billing_state"),
    billing_state_synced_at: timestamp("billing_state_synced_at", { withTimezone: true }),
    billing_state_error: text("billing_state_error"),
    delivery_usage_cursor_at: timestamp("delivery_usage_cursor_at", { withTimezone: true }),
    delivery_usage_synced_at: timestamp("delivery_usage_synced_at", { withTimezone: true }),
    delivery_usage_error: text("delivery_usage_error"),
    storage_usage_cursor_at: timestamp("storage_usage_cursor_at", { withTimezone: true }),
    storage_usage_synced_at: timestamp("storage_usage_synced_at", { withTimezone: true }),
    storage_usage_error: text("storage_usage_error"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("billing_customers_mode_synced_idx").on(table.billing_mode, table.customer_synced_at),
  ]
);

export const billingUsageEvents = rend.table(
  "billing_usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    asset_id: uuid("asset_id"),
    idempotency_key: text("idempotency_key").notNull(),
    feature_id: text("feature_id").notNull(),
    value: doublePrecision("value").notNull(),
    source: text("source").notNull(),
    status: text("status").notNull().default("pending"),
    error: text("error"),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    tracked_at: timestamp("tracked_at", { withTimezone: true }),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("billing_usage_events_idempotency_key_uidx").on(table.idempotency_key),
    index("billing_usage_events_org_created_idx").on(table.organization_id, table.created_at),
    index("billing_usage_events_status_created_idx").on(table.status, table.created_at),
  ]
);

export const billingStorageSpans = rend.table(
  "billing_storage_spans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organization_id: uuid("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    asset_id: uuid("asset_id")
      .notNull()
      .references(() => assets.id, { onDelete: "cascade" }),
    duration_ms: bigint("duration_ms", { mode: "number" }).notNull(),
    resolution_tier: text("resolution_tier").notNull(),
    started_at: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    ended_at: timestamp("ended_at", { withTimezone: true }),
    created_at: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updated_at: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("billing_storage_spans_asset_open_uidx")
      .on(table.asset_id)
      .where(sql`${table.ended_at} IS NULL`),
    index("billing_storage_spans_org_window_idx").on(
      table.organization_id,
      table.resolution_tier,
      table.started_at,
      table.ended_at
    ),
  ]
);

export const userRelations = relations(user, ({ many }) => ({
  sessions: many(session),
  accounts: many(account),
  members: many(member),
}));

export const sessionRelations = relations(session, ({ one }) => ({
  user: one(user, { fields: [session.user_id], references: [user.id] }),
  organization: one(organization, {
    fields: [session.active_organization_id],
    references: [organization.id],
  }),
}));

export const accountRelations = relations(account, ({ one }) => ({
  user: one(user, { fields: [account.user_id], references: [user.id] }),
}));

export const organizationRelations = relations(organization, ({ many }) => ({
  members: many(member),
  invitations: many(invitation),
  billingCustomers: many(billingCustomers),
}));

export const memberRelations = relations(member, ({ one }) => ({
  user: one(user, { fields: [member.user_id], references: [user.id] }),
  organization: one(organization, {
    fields: [member.organization_id],
    references: [organization.id],
  }),
}));

export const invitationRelations = relations(invitation, ({ one }) => ({
  organization: one(organization, {
    fields: [invitation.organization_id],
    references: [organization.id],
  }),
  inviter: one(user, { fields: [invitation.inviter_id], references: [user.id] }),
}));

export const authSchema = {
  user,
  session,
  account,
  verification,
  rateLimit,
  organization,
  member,
  invitation,
};

export const schema = {
  ...authSchema,
  assets,
  apiKeys,
  operatorAuditRecords,
  billingCustomers,
  billingUsageEvents,
  billingStorageSpans,
  userRelations,
  sessionRelations,
  accountRelations,
  organizationRelations,
  memberRelations,
  invitationRelations,
};
