export type DigestSchedule = {
  dayOfWeek: number;
  hour: number;
  minute: number;
  timezone: string;
  paused: boolean;
};

type LocalDateTime = {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
  second: number;
};

const weekdayNumbers: Record<string, number> = {
  Sun: 7,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function getLocalDateTime(date: Date, timezone: string): LocalDateTime {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    weekday: weekdayNumbers[values.weekday ?? ""] ?? 0,
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function wallClockMilliseconds(value: Pick<LocalDateTime, "year" | "month" | "day" | "hour" | "minute" | "second">) {
  return Date.UTC(value.year, value.month - 1, value.day, value.hour, value.minute, value.second);
}

function getOffsetMinutes(date: Date, timezone: string) {
  const local = getLocalDateTime(date, timezone);
  return (wallClockMilliseconds(local) - date.getTime()) / 60_000;
}

function localDateTimeToUtc(value: LocalDateTime, timezone: string) {
  const desiredWallClock = wallClockMilliseconds(value);
  const offsets = new Set<number>();
  for (let days = -2; days <= 2; days += 1) {
    offsets.add(getOffsetMinutes(new Date(desiredWallClock + days * 24 * 60 * 60_000), timezone));
  }

  const exactMatches = [...offsets]
    .map((offset) => new Date(desiredWallClock - offset * 60_000))
    .filter((candidate) => wallClockMilliseconds(getLocalDateTime(candidate, timezone)) === desiredWallClock)
    .sort((left, right) => left.getTime() - right.getTime());
  if (exactMatches[0]) return exactMatches[0];

  // A local time can be skipped by a DST transition. Choose the first valid
  // local minute after the requested time on that local date.
  for (let minutes = -24 * 60; minutes <= 24 * 60; minutes += 1) {
    const candidate = new Date(desiredWallClock + minutes * 60_000);
    const local = getLocalDateTime(candidate, timezone);
    if (
      local.year === value.year &&
      local.month === value.month &&
      local.day === value.day &&
      wallClockMilliseconds(local) >= desiredWallClock
    ) {
      return candidate;
    }
  }

  throw new Error(`Could not resolve local time in ${timezone}`);
}

export function getNextDigestDelivery(schedule: DigestSchedule, now = new Date()) {
  if (schedule.paused) return null;

  const localNow = getLocalDateTime(now, schedule.timezone);
  let daysUntilDelivery = (schedule.dayOfWeek - localNow.weekday + 7) % 7;
  const currentMinutes = localNow.hour * 60 + localNow.minute;
  const deliveryMinutes = schedule.hour * 60 + schedule.minute;
  if (daysUntilDelivery === 0 && deliveryMinutes <= currentMinutes) daysUntilDelivery = 7;

  const localDate = new Date(Date.UTC(localNow.year, localNow.month - 1, localNow.day + daysUntilDelivery));
  const candidate = localDateTimeToUtc({
    year: localDate.getUTCFullYear(),
    month: localDate.getUTCMonth() + 1,
    day: localDate.getUTCDate(),
    weekday: schedule.dayOfWeek,
    hour: schedule.hour,
    minute: schedule.minute,
    second: 0,
  }, schedule.timezone);

  return candidate.getTime() > now.getTime() ? candidate : new Date(candidate.getTime() + 7 * 24 * 60 * 60_000);
}
