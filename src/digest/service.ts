import type postgres from "postgres";

import { applicationUrl, emailActionUrl, ensureEmailActionToken, feedbackActionLabels } from "@/email/actions";
import { safeErrorMessage } from "@/observability/log";
import { feedbackActions, type FeedbackAction } from "@/rotation/service";
import { getMostRecentDigestDelivery } from "./schedule";

const rotationEpoch = new Date(0);
const minimumRepositoryAgeMs = 30 * 24 * 60 * 60_000;
const inactivityPauseThreshold = 3;

type DigestScheduleRow = {
  user_id: number;
  day_of_week: number;
  hour: number;
  minute: number;
  timezone: string;
  item_count: number;
  paused: boolean;
  created_at: Date;
};

export type DigestEmailItem = {
  digestItemId: number;
  position: number;
  ownerLogin: string;
  name: string;
  fullName: string;
  description: string | null;
  language: string | null;
  starCount: number;
  htmlUrl: string;
  actionLinks: Record<FeedbackAction, string>;
};

export type ClaimedDigest = {
  digestId: number;
  userId: number;
  email: string;
  periodKey: string;
  scheduledFor: Date;
  pauseUrl: string;
  items: DigestEmailItem[];
};

export type PauseNoticePayload = {
  userId: number;
  pauseGeneration: number;
};

function escapeHtml(value: string) {
  return value.replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]!);
}

export function renderDigestEmail(digest: Pick<ClaimedDigest, "periodKey" | "items"> & { pauseUrl?: string }) {
  const title = "Your weekly ReStar Digest";
  const pauseUrl = digest.pauseUrl ?? applicationUrl("/settings");
  const itemText = digest.items.length === 0
    ? "No Eligible Repositories were available this week."
    : digest.items.map((item) => [
      `- ${item.fullName}`,
      item.description ? `  ${item.description}` : "",
      `  ${item.language ?? "Unknown language"} · ${item.starCount.toLocaleString()} stars`,
      `  ${item.htmlUrl}`,
      `  Actions: ${feedbackActions.map((action) => `${feedbackActionLabels[action]}: ${item.actionLinks[action]}`).join(" | ")}`,
    ].filter(Boolean).join("\n")).join("\n\n");
  const htmlItems = digest.items.length === 0
    ? "<p>No Eligible Repositories were available this week.</p>"
    : `<ol>${digest.items.map((item) => `<li><p><a href="${escapeHtml(item.htmlUrl)}"><strong>${escapeHtml(item.fullName)}</strong></a></p>${item.description ? `<p>${escapeHtml(item.description)}</p>` : ""}<p>${escapeHtml(item.language ?? "Unknown language")} · ${item.starCount.toLocaleString()} stars</p><p>${feedbackActions.map((action) => `<a href="${escapeHtml(item.actionLinks[action])}">${feedbackActionLabels[action]}</a>`).join(" · ")}</p></li>`).join("")}</ol>`;
  return {
    subject: `${title} · ${digest.items.length} ${digest.items.length === 1 ? "repository" : "repositories"}`,
    text: `${title}\n\n${itemText}\n\nReview your Rotation at ReStar.\nPause future Digests: ${pauseUrl}`,
    html: `<main><h1>${title}</h1>${htmlItems}<p>Review your Rotation at ReStar.</p><p><a href="${escapeHtml(pauseUrl)}">Pause future Digests</a></p></main>`,
  };
}

export function renderPauseNoticeEmail(settingsUrl = applicationUrl("/settings")) {
  const title = "Your ReStar Digests are paused";
  return {
    subject: title,
    text: `${title}. ReStar paused scheduled delivery after three consecutive Digests without a Feedback Action. Resume delivery any time in settings: ${settingsUrl}`,
    html: `<main><h1>${title}</h1><p>ReStar paused scheduled delivery after three consecutive Digests without a Feedback Action.</p><p><a href="${escapeHtml(settingsUrl)}">Resume delivery in settings</a></p></main>`,
  };
}

export async function enqueueDueDigests(client: ReturnType<typeof postgres>, now: Date) {
  return client.begin(async (transaction) => {
    const schedules = await transaction<DigestScheduleRow[]>`
      select users.id as user_id,
        coalesce(digest_preferences.day_of_week, 1) as day_of_week,
        coalesce(digest_preferences.hour, 9) as hour,
        coalesce(digest_preferences.minute, 0) as minute,
        coalesce(digest_preferences.timezone, 'UTC') as timezone,
        coalesce(digest_preferences.item_count, 4) as item_count,
        coalesce(digest_preferences.paused, false) as paused,
        coalesce(digest_preferences.created_at, users.created_at) as created_at
      from users
      left join digest_preferences on digest_preferences.user_id = users.id
    `;
    let enqueued = 0;
    for (const schedule of schedules) {
      await transaction`select pg_advisory_xact_lock(${schedule.user_id})`;
      const currentUser = await transaction<{ id: number }[]>`
        select id from users where id = ${schedule.user_id}
      `;
      if (currentUser.length === 0) continue;
      const scheduledFor = getMostRecentDigestDelivery({
        dayOfWeek: schedule.day_of_week,
        hour: schedule.hour,
        minute: schedule.minute,
        timezone: schedule.timezone,
        paused: schedule.paused,
      }, now);
      if (!scheduledFor || scheduledFor.getTime() > now.getTime() || scheduledFor.getTime() <= schedule.created_at.getTime()) continue;

      const periodKey = scheduledFor.toISOString();
      const inserted = await transaction<{ id: number }[]>`
        insert into jobs (kind, payload, idempotency_key, run_after)
        values (
          'digest-prepare',
          ${transaction.json({
            userId: schedule.user_id,
            periodKey,
            scheduledFor: periodKey,
            itemCount: schedule.item_count,
          })},
          ${`digest-prepare:${schedule.user_id}:${periodKey}`},
          ${now}
        )
        on conflict (idempotency_key) do nothing
        returning id
      `;
      enqueued += inserted.length;
    }
    return enqueued;
  });
}

type DigestPayload = {
  userId: number;
  periodKey: string;
  scheduledFor: string;
  itemCount: number;
};

export function parseDigestPayload(payload: unknown): DigestPayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid Digest preparation payload");
  }
  const value = payload as Record<string, unknown>;
  const userId = Number(value.userId);
  const itemCount = Number(value.itemCount);
  if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(itemCount) || ![3, 4, 5].includes(itemCount)) {
    throw new Error("Invalid Digest preparation payload");
  }
  if (typeof value.periodKey !== "string" || typeof value.scheduledFor !== "string") {
    throw new Error("Invalid Digest preparation payload");
  }
  const scheduledFor = new Date(value.scheduledFor);
  if (Number.isNaN(scheduledFor.getTime())) throw new Error("Invalid Digest preparation payload");
  return { userId, periodKey: value.periodKey, scheduledFor: value.scheduledFor, itemCount };
}

export function parseDigestDeliveryPayload(payload: unknown) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid Digest delivery payload");
  }
  const value = payload as Record<string, unknown>;
  const digestId = Number(value.digestId);
  const userId = Number(value.userId);
  if (!Number.isSafeInteger(digestId) || !Number.isSafeInteger(userId)) {
    throw new Error("Invalid Digest delivery payload");
  }
  return { digestId, userId };
}

export function parsePauseNoticePayload(payload: unknown): PauseNoticePayload {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Invalid Digest pause notice payload");
  }
  const value = payload as Record<string, unknown>;
  const userId = Number(value.userId);
  const pauseGeneration = Number(value.pauseGeneration);
  if (!Number.isSafeInteger(userId) || !Number.isSafeInteger(pauseGeneration) || pauseGeneration < 1) {
    throw new Error("Invalid Digest pause notice payload");
  }
  return { userId, pauseGeneration };
}

export async function createDigest(client: ReturnType<typeof postgres>, payload: DigestPayload) {
  const created = await client<{ id: number }[]>`
    insert into digests (user_id, period_key, scheduled_for, item_count)
    values (${payload.userId}, ${payload.periodKey}, ${new Date(payload.scheduledFor)}, ${payload.itemCount})
    on conflict (user_id, period_key) do nothing
    returning id
  `;
  if (created[0]) return created[0].id;
  const existing = await client<{ id: number }[]>`
    select id from digests where user_id = ${payload.userId} and period_key = ${payload.periodKey}
  `;
  if (!existing[0]) throw new Error("Digest could not be created");
  return existing[0].id;
}

export async function claimDigestForDelivery(
  client: ReturnType<typeof postgres>,
  digestId: number,
  userId: number,
  now: Date,
  options: { actionTokenSecret?: string; actionBaseUrl?: string } = {},
): Promise<ClaimedDigest | null> {
  return client.begin(async (transaction) => {
    const digests = await transaction<{
      id: number;
      user_id: number;
      period_key: string;
      scheduled_for: Date;
      item_count: number;
      status: string;
      email: string | null;
      paused: boolean;
    }[]>`
      select digests.id, digests.user_id, digests.period_key, digests.scheduled_for,
        digests.item_count, digests.status, users.email, coalesce(digest_preferences.paused, false) as paused
      from digests
      join users on users.id = digests.user_id
      left join digest_preferences on digest_preferences.user_id = digests.user_id
      where digests.id = ${digestId} and digests.user_id = ${userId}
      for update of digests
    `;
    const digest = digests[0];
    if (!digest) throw new Error("Digest not found");
    if (digest.status === "sent") return null;
    if (digest.paused) {
      await transaction`
        update digests set status = 'failed', last_error = 'Digest is paused', updated_at = now()
        where id = ${digest.id}
      `;
      return null;
    }
    if (!digest.email) throw new Error("User has no email address");

    let items = await transaction<{
      id: number;
      position: number;
      owner_login: string;
      name: string;
      full_name: string;
      description: string | null;
      language: string | null;
      star_count: number;
      html_url: string;
    }[]>`
      select id, position, owner_login, name, full_name, description, language, star_count, html_url
      from digest_items where digest_id = ${digest.id} order by position
    `;

    if (items.length === 0) {
      const cutoff = new Date(now.getTime() - minimumRepositoryAgeMs);
      const selected = await transaction<{
        repository_id: number;
        owner_login: string;
        name: string;
        full_name: string;
        description: string | null;
        language: string | null;
        star_count: number;
        html_url: string;
        starred_at: Date;
      }[]>`
        select repositories.id as repository_id, repositories.owner_login, repositories.name,
          repositories.full_name, repositories.description, repositories.language,
          repositories.star_count, repositories.html_url, starred_repositories.starred_at
        from starred_repositories
        join repositories on repositories.id = starred_repositories.repository_id
        left join rotation_states on rotation_states.user_id = starred_repositories.user_id
          and rotation_states.repository_id = starred_repositories.repository_id
        where starred_repositories.user_id = ${userId}
          and starred_repositories.starred_at <= ${cutoff}
          and coalesce(rotation_states.status, 'active') = 'active'
          and coalesce(rotation_states.next_eligible_at, ${rotationEpoch}) <= ${now}
        order by
          case when rotation_states.last_presented_at is null then 0 else 1 end,
          rotation_states.last_presented_at asc nulls last,
          starred_repositories.starred_at asc,
          repositories.id asc
        limit ${digest.item_count}
        for update of starred_repositories
      `;
      for (const [index, repository] of selected.entries()) {
        await transaction`
          insert into digest_items (
            digest_id, position, repository_id, owner_login, name, full_name, description,
            language, star_count, html_url, starred_at
          ) values (
            ${digest.id}, ${index + 1}, ${repository.repository_id}, ${repository.owner_login},
            ${repository.name}, ${repository.full_name}, ${repository.description}, ${repository.language},
            ${repository.star_count}, ${repository.html_url}, ${repository.starred_at}
          )
        `;
        await transaction`
          insert into rotation_states (user_id, repository_id, status, next_eligible_at, last_presented_at)
          values (${userId}, ${repository.repository_id}, 'active', ${rotationEpoch}, ${now})
          on conflict (user_id, repository_id) do update set last_presented_at = ${now}, updated_at = now()
        `;
      }
      items = await transaction`
        select id, position, owner_login, name, full_name, description, language, star_count, html_url
        from digest_items where digest_id = ${digest.id} order by position
      `;
    }

    const actionLinks = new Map<number, Record<FeedbackAction, string>>();
    for (const item of items) {
      const links = {} as Record<FeedbackAction, string>;
      for (const action of feedbackActions) {
        const token = await ensureEmailActionToken(transaction, {
          userId: digest.user_id,
          digestItemId: item.id,
          action,
        }, options.actionTokenSecret, now);
        links[action] = emailActionUrl(token, options.actionBaseUrl);
      }
      actionLinks.set(item.id, links);
    }

    await transaction`
      update digests set status = 'sending', attempts = attempts + 1, last_error = null, updated_at = now()
      where id = ${digest.id}
    `;
    return {
      digestId: digest.id,
      userId: digest.user_id,
      email: digest.email,
      periodKey: digest.period_key,
      scheduledFor: digest.scheduled_for,
      pauseUrl: applicationUrl("/settings", options.actionBaseUrl),
      items: items.map((item) => ({
        digestItemId: item.id,
        position: item.position,
        ownerLogin: item.owner_login,
        name: item.name,
        fullName: item.full_name,
        description: item.description,
        language: item.language,
        starCount: item.star_count,
        htmlUrl: item.html_url,
        actionLinks: actionLinks.get(item.id)!,
      })),
    };
  });
}

export async function markDigestSent(client: ReturnType<typeof postgres>, digestId: number, now: Date) {
  return client.begin(async (transaction) => {
    const digest = await transaction<{ user_id: number }[]>`
      select user_id from digests where id = ${digestId}
    `;
    if (digest.length === 0) return { newlySent: false, paused: false };

    await transaction`
      insert into digest_preferences (user_id)
      values (${digest[0]!.user_id})
      on conflict (user_id) do nothing
    `;
    const preferences = await transaction<{
      paused: boolean;
      inactivity_count: number;
      pause_generation: number;
    }[]>`
      select paused, inactivity_count, pause_generation
      from digest_preferences
      where user_id = ${digest[0]!.user_id}
      for update
    `;
    const sent = await transaction<{ user_id: number; feedback_action_count: number }[]>`
      update digests set status = 'sent', delivered_at = ${now}, last_error = null, updated_at = now()
      where id = ${digestId} and status <> 'sent'
      returning user_id, feedback_action_count
    `;
    if (sent.length === 0) return { newlySent: false, paused: false };
    const current = preferences[0]!;
    if (sent[0]!.feedback_action_count > 0) {
      await transaction`
        update digest_preferences
        set inactivity_count = 0, updated_at = now()
        where user_id = ${sent[0]!.user_id}
      `;
      return { newlySent: true, paused: current.paused };
    }

    const inactivityCount = current.inactivity_count + 1;
    const shouldPause = !current.paused && inactivityCount >= inactivityPauseThreshold;
    const pauseGeneration = shouldPause ? current.pause_generation + 1 : current.pause_generation;
    await transaction`
      update digest_preferences
      set inactivity_count = ${inactivityCount},
        paused = case when ${shouldPause} then true else paused end,
        pause_generation = ${pauseGeneration},
        pause_notice_sent_at = case when ${shouldPause} then null else pause_notice_sent_at end,
        updated_at = now()
      where user_id = ${sent[0]!.user_id}
    `;
    if (shouldPause) {
      await transaction`
        insert into jobs (kind, payload, idempotency_key, run_after)
        values (
          'digest-pause-notice',
          ${transaction.json({ userId: sent[0]!.user_id, pauseGeneration })},
          ${`digest-pause-notice:${sent[0]!.user_id}:${pauseGeneration}`},
          ${now}
        )
        on conflict (idempotency_key) do nothing
      `;
    }
    return { newlySent: true, paused: shouldPause };
  });
}

export async function markDigestFailed(client: ReturnType<typeof postgres>, digestId: number, message: string) {
  await client`
    update digests set status = 'failed', last_error = ${safeErrorMessage(message)}, updated_at = now()
    where id = ${digestId} and status <> 'sent'
  `;
}
