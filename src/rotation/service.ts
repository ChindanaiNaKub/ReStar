import type postgres from "postgres";

export const feedbackActions = ["still_interested", "snooze", "done", "forget"] as const;
export type FeedbackAction = (typeof feedbackActions)[number];

const rotationEpoch = new Date(0);
const dayMs = 24 * 60 * 60 * 1000;
const minimumRepositoryAgeMs = 30 * dayMs;

export type RotationRepository = {
  repositoryId: number;
  ownerLogin: string;
  name: string;
  fullName: string;
  description: string | null;
  language: string | null;
  starCount: number;
  htmlUrl: string;
  starredAt: string;
  lastPresentedAt: string;
  nextEligibleAt: string;
};

export type RotationStatus = "active" | "done" | "forgotten";

export class RotationRepositoryNotFound extends Error {}
export class RotationRepositoryNotEligible extends Error {}

export function isFeedbackAction(value: unknown): value is FeedbackAction {
  return typeof value === "string" && feedbackActions.includes(value as FeedbackAction);
}

export async function getEligibleRotation(
  client: ReturnType<typeof postgres>,
  userId: number,
  now: Date,
) {
  const cutoff = new Date(now.getTime() - minimumRepositoryAgeMs);
  return client.begin(async (transaction) => {
    const rows = await transaction<{
      repository_id: number;
      owner_login: string;
      name: string;
      full_name: string;
      description: string | null;
      language: string | null;
      star_count: number;
      html_url: string;
      starred_at: Date;
      next_eligible_at: Date | null;
      last_presented_at: Date | null;
    }[]>`
      select
        repositories.id as repository_id,
        repositories.owner_login,
        repositories.name,
        repositories.full_name,
        repositories.description,
        repositories.language,
        repositories.star_count,
        repositories.html_url,
        starred_repositories.starred_at,
        rotation_states.next_eligible_at,
        rotation_states.last_presented_at
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
    `;

    for (const row of rows) {
      await transaction`
        insert into rotation_states (user_id, repository_id, status, next_eligible_at, last_presented_at)
        values (${userId}, ${row.repository_id}, 'active', ${row.next_eligible_at ?? rotationEpoch}, ${now})
        on conflict (user_id, repository_id) do update set
          last_presented_at = ${now}, updated_at = now()
      `;
    }

    return rows.map((row) => ({
      repositoryId: row.repository_id,
      ownerLogin: row.owner_login,
      name: row.name,
      fullName: row.full_name,
      description: row.description,
      language: row.language,
      starCount: row.star_count,
      htmlUrl: row.html_url,
      starredAt: row.starred_at.toISOString(),
      lastPresentedAt: now.toISOString(),
      nextEligibleAt: (row.next_eligible_at ?? rotationEpoch).toISOString(),
    } satisfies RotationRepository));
  });
}

export async function recordFeedback(
  client: ReturnType<typeof postgres>,
  userId: number,
  repositoryId: number,
  action: FeedbackAction,
  now: Date,
) {
  return client.begin(async (transaction) => {
    const rows = await transaction<{
      status: RotationStatus | null;
      next_eligible_at: Date | null;
      starred_at: Date;
      latest_action: FeedbackAction | null;
    }[]>`
      select rotation_states.status, rotation_states.next_eligible_at, starred_repositories.starred_at,
        latest_feedback.action as latest_action
      from starred_repositories
      left join rotation_states on rotation_states.user_id = starred_repositories.user_id
        and rotation_states.repository_id = starred_repositories.repository_id
      left join lateral (
        select action from rotation_feedback_events
        where user_id = starred_repositories.user_id and repository_id = starred_repositories.repository_id
        order by id desc limit 1
      ) as latest_feedback on true
      where starred_repositories.user_id = ${userId}
        and starred_repositories.repository_id = ${repositoryId}
      for update of starred_repositories
    `;
    const current = rows[0];
    if (!current) throw new RotationRepositoryNotFound("Starred Repository is not in Rotation");

    const currentStatus = current.status ?? "active";
    const terminal = currentStatus === "done" || currentStatus === "forgotten";
    const terminalAction: FeedbackAction = currentStatus === "done" ? "done" : "forget";
    if (terminal && action !== terminalAction) {
      throw new RotationRepositoryNotEligible("Terminal Feedback Action cannot be changed");
    }
    const currentlyEligible = current.starred_at.getTime() <= now.getTime() - minimumRepositoryAgeMs
      && (current.next_eligible_at ?? rotationEpoch).getTime() <= now.getTime();
    const repeatedCooldown = currentStatus === "active"
      && current.latest_action === action
      && (current.next_eligible_at ?? rotationEpoch).getTime() > now.getTime();
    if (!terminal && !currentlyEligible && !repeatedCooldown) {
      throw new RotationRepositoryNotEligible("Starred Repository is not currently eligible");
    }
    const resultingStatus: RotationStatus = terminal
      ? currentStatus
      : action === "done"
        ? "done"
        : action === "forget"
          ? "forgotten"
          : "active";
    const nextEligibleAt = repeatedCooldown
      ? current.next_eligible_at!
      : resultingStatus === "active"
      ? new Date(now.getTime() + (action === "snooze" ? 30 : 90) * dayMs)
      : rotationEpoch;
    const eventNextEligibleAt = resultingStatus === "active" ? nextEligibleAt : null;

    await transaction`
      insert into rotation_feedback_events (
        user_id, repository_id, action, occurred_at, next_eligible_at, resulting_status
      ) values (
        ${userId}, ${repositoryId}, ${action}, ${now}, ${eventNextEligibleAt}, ${resultingStatus}
      )
    `;
    await transaction`
      insert into rotation_states (user_id, repository_id, status, next_eligible_at)
      values (${userId}, ${repositoryId}, ${resultingStatus}, ${nextEligibleAt})
      on conflict (user_id, repository_id) do update set
        status = ${resultingStatus}, next_eligible_at = ${nextEligibleAt}, updated_at = now()
    `;

    return {
      action,
      status: resultingStatus,
      nextEligibleAt: eventNextEligibleAt?.toISOString() ?? null,
    };
  });
}
