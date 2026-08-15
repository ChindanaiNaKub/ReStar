import { createHmac, timingSafeEqual } from "node:crypto";
import type postgres from "postgres";

import { hashToken, randomToken } from "@/auth/crypto";
import {
  feedbackActions,
  recordFeedbackInTransaction,
  type FeedbackAction,
  type RotationStatus,
} from "@/rotation/service";

export const emailActionTokenTtlMs = 7 * 24 * 60 * 60 * 1_000;

export const feedbackActionLabels: Record<FeedbackAction, string> = {
  still_interested: "Still Interested",
  snooze: "Snooze",
  done: "Done",
  forget: "Forget",
};

type TokenKind = "action" | "undo";

export type EmailActionTokenClaims = {
  kind: TokenKind;
  userId: number;
  digestItemId: number;
  action: FeedbackAction;
  nonce: string;
  expiresAt: Date;
};

export class EmailActionTokenError extends Error {
  constructor(readonly reason: "invalid" | "expired" | "used" | "already_applied" | "not_undoable") {
    super(`Email action token is ${reason}`);
    this.name = "EmailActionTokenError";
  }
}

export type EmailActionPreview = {
  digestItemId: number;
  repositoryId: number;
  fullName: string;
  description: string | null;
  action: FeedbackAction;
  expiresAt: Date;
};

export type AppliedEmailAction = EmailActionPreview & {
  status: RotationStatus;
  nextEligibleAt: string | null;
  undoToken: string;
};

type QueryExecutor = postgres.Sql | postgres.TransactionSql;

function asDate(value: Date | string) {
  return value instanceof Date ? value : new Date(value);
}

function encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64url");
}

function decode(value: string) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function secretValue(secret?: string) {
  const value = secret ?? process.env.EMAIL_ACTION_TOKEN_SECRET ?? process.env.GITHUB_TOKEN_ENCRYPTION_KEY;
  if (!value) throw new Error("EMAIL_ACTION_TOKEN_SECRET is required");
  return value;
}

export function getEmailActionTokenSecret(secret?: string) {
  return secretValue(secret);
}

function sign(payload: string, secret: string) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function tokensMatch(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function tokenPayload(claims: EmailActionTokenClaims) {
  return encode(JSON.stringify({
    v: 1,
    k: claims.kind,
    u: claims.userId,
    d: claims.digestItemId,
    a: claims.action,
    n: claims.nonce,
    e: claims.expiresAt.getTime(),
  }));
}

export function createEmailActionToken(claims: EmailActionTokenClaims, secret?: string) {
  const payload = tokenPayload(claims);
  return `v1.${payload}.${sign(payload, secretValue(secret))}`;
}

export function createUndoToken(claims: Omit<EmailActionTokenClaims, "kind">, secret?: string) {
  return createEmailActionToken({ ...claims, kind: "undo" }, secret);
}

export function verifyEmailActionToken(token: string, secret?: string, now = new Date()): EmailActionTokenClaims {
  try {
    const [version, payload, signature] = token.split(".");
    if (version !== "v1" || !payload || !signature || !tokensMatch(signature, sign(payload, secretValue(secret)))) {
      throw new EmailActionTokenError("invalid");
    }
    const value = JSON.parse(decode(payload)) as Record<string, unknown>;
    const userId = Number(value.u);
    const digestItemId = Number(value.d);
    const expiresAtMs = Number(value.e);
    if (
      value.v !== 1
      || (value.k !== "action" && value.k !== "undo")
      || typeof value.a !== "string"
      || !feedbackActions.includes(value.a as FeedbackAction)
      || typeof value.n !== "string"
      || value.n.length < 16
      || !Number.isSafeInteger(userId)
      || !Number.isSafeInteger(digestItemId)
      || !Number.isSafeInteger(expiresAtMs)
    ) throw new EmailActionTokenError("invalid");
    const expiresAt = new Date(expiresAtMs);
    if (expiresAt.getTime() <= now.getTime()) throw new EmailActionTokenError("expired");
    return {
      kind: value.k,
      userId,
      digestItemId,
      action: value.a as FeedbackAction,
      nonce: value.n,
      expiresAt,
    };
  } catch (error) {
    if (error instanceof EmailActionTokenError) throw error;
    throw new EmailActionTokenError("invalid");
  }
}

export function emailActionUrl(token: string, baseUrl?: string) {
  const configuredBaseUrl = baseUrl ?? process.env.APP_URL ?? (
    process.env.APP_DOMAIN ? `https://${process.env.APP_DOMAIN}` : "http://localhost:3000"
  );
  const url = new URL("/email/action", configuredBaseUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

type IssueEmailActionTokenInput = {
  userId: number;
  digestItemId: number;
  action: FeedbackAction;
  expiresAt?: Date;
};

export async function ensureEmailActionToken(
  client: QueryExecutor,
  input: IssueEmailActionTokenInput,
  secret?: string,
  now = new Date(),
) {
  const existing = await client<{ nonce: string; expires_at: Date; used_at: Date | null }[]>`
    select nonce, expires_at, used_at
    from email_action_tokens
    where digest_item_id = ${input.digestItemId} and intended_action = ${input.action}
    for update
  `;
  let nonce = existing[0]?.nonce;
  let expiresAt = existing[0] ? asDate(existing[0].expires_at) : undefined;
  if (!existing[0] || (!existing[0].used_at && expiresAt!.getTime() <= now.getTime())) {
    nonce = randomToken();
    expiresAt = input.expiresAt ?? new Date(now.getTime() + emailActionTokenTtlMs);
    await client`
      insert into email_action_tokens (
        nonce_hash, nonce, user_id, digest_item_id, intended_action, expires_at
      ) values (
        ${hashToken(nonce)}, ${nonce}, ${input.userId}, ${input.digestItemId}, ${input.action}, ${expiresAt}
      )
      on conflict (digest_item_id, intended_action) do update set
        nonce_hash = excluded.nonce_hash,
        nonce = excluded.nonce,
        expires_at = excluded.expires_at,
        used_at = null,
        feedback_event_id = null,
        previous_status = null,
        previous_next_eligible_at = null,
        undone_at = null
    `;
  }
  const tokenNonce = nonce ?? randomToken();
  const tokenExpiresAt = asDate(expiresAt ?? input.expiresAt ?? new Date(now.getTime() + emailActionTokenTtlMs));
  return createEmailActionToken({
    kind: "action",
    userId: input.userId,
    digestItemId: input.digestItemId,
    action: input.action,
    nonce: tokenNonce,
    expiresAt: tokenExpiresAt,
  }, secret);
}

export async function issueEmailActionToken(
  client: ReturnType<typeof postgres>,
  input: IssueEmailActionTokenInput,
  secret?: string,
  now = new Date(),
) {
  return client.begin((transaction) => ensureEmailActionToken(transaction, input, secret, now));
}

async function emailActionRow(
  client: QueryExecutor,
  claims: EmailActionTokenClaims,
  now: Date,
  allowUsed = false,
) {
  const rows = await client<{
    nonce: string;
    user_id: number;
    digest_item_id: number;
    intended_action: FeedbackAction;
    expires_at: Date;
    used_at: Date | null;
    feedback_event_id: number | null;
    previous_status: RotationStatus | null;
    previous_next_eligible_at: Date | null;
    undone_at: Date | null;
    repository_id: number;
    full_name: string;
    description: string | null;
  }[]>`
    select tokens.nonce, tokens.user_id, tokens.digest_item_id, tokens.intended_action,
      tokens.expires_at, tokens.used_at, tokens.feedback_event_id, tokens.previous_status,
      tokens.previous_next_eligible_at, tokens.undone_at,
      digest_items.repository_id, digest_items.full_name, digest_items.description
    from email_action_tokens as tokens
    join digest_items on digest_items.id = tokens.digest_item_id
    where tokens.nonce_hash = ${hashToken(claims.nonce)}
      and tokens.user_id = ${claims.userId}
      and tokens.digest_item_id = ${claims.digestItemId}
      and tokens.intended_action = ${claims.action}
    for update
  `;
  const row = rows[0];
  if (!row || row.nonce !== claims.nonce) throw new EmailActionTokenError("invalid");
  if (asDate(row.expires_at).getTime() <= now.getTime()) throw new EmailActionTokenError("expired");
  if (row.used_at && !allowUsed) throw new EmailActionTokenError("used");
  return row;
}

export async function getEmailActionPreview(
  client: ReturnType<typeof postgres>,
  token: string,
  secret?: string,
  now = new Date(),
): Promise<EmailActionPreview> {
  const claims = verifyEmailActionToken(token, secret, now);
  if (claims.kind !== "action") throw new EmailActionTokenError("invalid");
  const row = await emailActionRow(client, claims, now);
  return {
    digestItemId: row.digest_item_id,
    repositoryId: row.repository_id,
    fullName: row.full_name,
    description: row.description,
    action: row.intended_action,
    expiresAt: asDate(row.expires_at),
  };
}

export async function applyEmailAction(
  client: ReturnType<typeof postgres>,
  token: string,
  secret?: string,
  now = new Date(),
): Promise<AppliedEmailAction> {
  const claims = verifyEmailActionToken(token, secret, now);
  if (claims.kind !== "action") throw new EmailActionTokenError("invalid");
  return client.begin(async (transaction) => {
    const row = await emailActionRow(transaction, claims, now);
    await transaction`
      select id from digest_items where id = ${claims.digestItemId} for update
    `;
    const otherEffective = await transaction<{ nonce_hash: string }[]>`
      select nonce_hash from email_action_tokens
      where digest_item_id = ${claims.digestItemId} and used_at is not null and undone_at is null
        and nonce_hash <> ${hashToken(claims.nonce)}
      limit 1
    `;
    if (otherEffective.length > 0) throw new EmailActionTokenError("already_applied");

    const result = await recordFeedbackInTransaction(transaction, claims.userId, row.repository_id, claims.action, now);
    await transaction`
      update email_action_tokens
      set used_at = ${now}, feedback_event_id = ${result.eventId},
        previous_status = ${result.previousStatus}, previous_next_eligible_at = ${result.previousNextEligibleAt}
      where nonce_hash = ${hashToken(claims.nonce)}
    `;
    return {
      digestItemId: row.digest_item_id,
      repositoryId: row.repository_id,
      fullName: row.full_name,
      description: row.description,
      action: row.intended_action,
      expiresAt: asDate(row.expires_at),
      status: result.status,
      nextEligibleAt: result.nextEligibleAt,
      undoToken: createUndoToken(claims, secret),
    };
  });
}

export async function undoEmailAction(
  client: ReturnType<typeof postgres>,
  token: string,
  secret?: string,
  now = new Date(),
) {
  const claims = verifyEmailActionToken(token, secret, now);
  if (claims.kind !== "undo") throw new EmailActionTokenError("invalid");
  return client.begin(async (transaction) => {
    const row = await emailActionRow(transaction, claims, now, true);
    if (!row.used_at || !row.feedback_event_id || row.undone_at) {
      throw new EmailActionTokenError("not_undoable");
    }
    if (!row.previous_status || !row.previous_next_eligible_at) {
      throw new EmailActionTokenError("not_undoable");
    }
    const latest = await transaction<{ id: number }[]>`
      select id from rotation_feedback_events
      where user_id = ${claims.userId} and repository_id = ${row.repository_id}
      order by id desc limit 1
    `;
    if (latest[0]?.id !== row.feedback_event_id) throw new EmailActionTokenError("not_undoable");

    await transaction`
      insert into rotation_feedback_events (
        user_id, repository_id, action, occurred_at, next_eligible_at, resulting_status, compensates_event_id
      ) values (
        ${claims.userId}, ${row.repository_id}, 'undo', ${now},
        ${row.previous_status === "active" ? row.previous_next_eligible_at : null},
        ${row.previous_status}, ${row.feedback_event_id}
      )
    `;
    await transaction`
      insert into rotation_states (user_id, repository_id, status, next_eligible_at)
      values (${claims.userId}, ${row.repository_id}, ${row.previous_status}, ${row.previous_next_eligible_at})
      on conflict (user_id, repository_id) do update set
        status = ${row.previous_status}, next_eligible_at = ${row.previous_next_eligible_at}, updated_at = now()
    `;
    await transaction`
      update email_action_tokens set undone_at = ${now}
      where nonce_hash = ${hashToken(claims.nonce)}
    `;
    return { undone: true, digestItemId: row.digest_item_id, repositoryId: row.repository_id };
  });
}
