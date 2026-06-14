import { relations } from "drizzle-orm";
import {
  boolean,
  bigint,
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
    index("verification_identifier_idx").on(table.identifier),
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
  created_at: timestamp("created_at", { withTimezone: true }).notNull(),
  updated_at: timestamp("updated_at", { withTimezone: true }).notNull(),
  deleted_at: timestamp("deleted_at", { withTimezone: true }),
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
  userRelations,
  sessionRelations,
  accountRelations,
  organizationRelations,
  memberRelations,
  invitationRelations,
};
