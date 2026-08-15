import type postgres from "postgres";

import { getNextDigestDelivery, type DigestSchedule } from "./schedule";

export const defaultDigestPreferences = {
  dayOfWeek: 1,
  hour: 9,
  minute: 0,
  itemCount: 4,
  paused: false,
} as const;

export type DigestPreferences = DigestSchedule & {
  itemCount: number;
};

export type DigestPreferencesView = DigestPreferences & {
  nextDeliveryAt: string | null;
};

export class InvalidDigestPreferencesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDigestPreferencesError";
  }
}

export function isValidIanaTimezone(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 100) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function parseInteger(value: unknown, field: string, minimum: number, maximum: number) {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new InvalidDigestPreferencesError(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

export function parseDigestPreferences(value: unknown): DigestPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidDigestPreferencesError("Digest preferences must be an object");
  }
  const input = value as Record<string, unknown>;
  if (!isValidIanaTimezone(input.timezone)) {
    throw new InvalidDigestPreferencesError("timezone must be a valid IANA timezone");
  }
  if (typeof input.paused !== "boolean") {
    throw new InvalidDigestPreferencesError("paused must be a boolean");
  }
  return {
    dayOfWeek: parseInteger(input.dayOfWeek, "dayOfWeek", 1, 7),
    hour: parseInteger(input.hour, "hour", 0, 23),
    minute: parseInteger(input.minute, "minute", 0, 59),
    timezone: input.timezone,
    itemCount: [3, 4, 5].includes(input.itemCount as number)
      ? input.itemCount as number
      : (() => { throw new InvalidDigestPreferencesError("itemCount must be 3, 4, or 5"); })(),
    paused: input.paused,
  };
}

function toPreferences(row: {
  day_of_week: number;
  hour: number;
  minute: number;
  timezone: string;
  item_count: number;
  paused: boolean;
}): DigestPreferences {
  return {
    dayOfWeek: row.day_of_week,
    hour: row.hour,
    minute: row.minute,
    timezone: row.timezone,
    itemCount: row.item_count,
    paused: row.paused,
  };
}

function toView(preferences: DigestPreferences, now: Date): DigestPreferencesView {
  return {
    ...preferences,
    nextDeliveryAt: getNextDigestDelivery(preferences, now)?.toISOString() ?? null,
  };
}

async function selectPreferences(client: ReturnType<typeof postgres>, userId: number) {
  const rows = await client<{
    day_of_week: number;
    hour: number;
    minute: number;
    timezone: string;
    item_count: number;
    paused: boolean;
  }[]>`
    select day_of_week, hour, minute, timezone, item_count, paused
    from digest_preferences
    where user_id = ${userId}
  `;
  return rows[0] ? toPreferences(rows[0]) : null;
}

export async function getDigestPreferences(
  client: ReturnType<typeof postgres>,
  userId: number,
  detectedTimezone: string | undefined,
  now = new Date(),
) {
  const existing = await selectPreferences(client, userId);
  if (existing) return toView(existing, now);

  const timezone = isValidIanaTimezone(detectedTimezone) ? detectedTimezone : "UTC";
  const created = await client<{
    day_of_week: number;
    hour: number;
    minute: number;
    timezone: string;
    item_count: number;
    paused: boolean;
  }[]>`
    insert into digest_preferences (user_id, day_of_week, hour, minute, timezone, item_count, paused)
    values (${userId}, ${defaultDigestPreferences.dayOfWeek}, ${defaultDigestPreferences.hour}, ${defaultDigestPreferences.minute}, ${timezone}, ${defaultDigestPreferences.itemCount}, ${defaultDigestPreferences.paused})
    on conflict (user_id) do nothing
    returning day_of_week, hour, minute, timezone, item_count, paused
  `;
  return toView(created[0] ? toPreferences(created[0]) : (await selectPreferences(client, userId))!, now);
}

export async function updateDigestPreferences(
  client: ReturnType<typeof postgres>,
  userId: number,
  value: unknown,
  now = new Date(),
) {
  const preferences = parseDigestPreferences(value);
  return client.begin(async (transaction) => {
    const updated = await transaction<{
      day_of_week: number;
      hour: number;
      minute: number;
      timezone: string;
      item_count: number;
      paused: boolean;
    }[]>`
      insert into digest_preferences (user_id, day_of_week, hour, minute, timezone, item_count, paused)
      values (${userId}, ${preferences.dayOfWeek}, ${preferences.hour}, ${preferences.minute}, ${preferences.timezone}, ${preferences.itemCount}, ${preferences.paused})
      on conflict (user_id) do update set
        day_of_week = excluded.day_of_week,
        hour = excluded.hour,
        minute = excluded.minute,
        timezone = excluded.timezone,
        item_count = excluded.item_count,
        paused = excluded.paused,
        inactivity_count = case
          when excluded.paused = false and digest_preferences.paused = true then 0
          else digest_preferences.inactivity_count
        end,
        pause_notice_sent_at = case
          when excluded.paused = false and digest_preferences.paused = true then null
          else digest_preferences.pause_notice_sent_at
        end,
        updated_at = now()
      returning day_of_week, hour, minute, timezone, item_count, paused
    `;
    return toView(toPreferences(updated[0]!), now);
  });
}
