import { CronExpressionParser } from "cron-parser";
import type { AutomationConfig, AutomationSchedule } from "../../contracts/automation-schema.js";

function cron(schedule: Extract<AutomationSchedule, { kind: "cron" }>, at: number) {
  if (schedule.expression.trim().split(/\s+/).length !== 5 || /\bH\b/i.test(schedule.expression))
    throw new Error(
      "Use a deterministic five-field cron expression (minute hour day month weekday)",
    );
  new Intl.DateTimeFormat("en", { timeZone: schedule.timezone }).format(at);
  return CronExpressionParser.parse(schedule.expression, {
    currentDate: at,
    tz: schedule.timezone,
  });
}

/** A wall-clock minute is scheduled once, at its earlier offset during a clock fold. */
function repeatedMinute(timezone: string) {
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    dateStyle: "short",
    timeStyle: "short",
    hourCycle: "h23",
  });
  const zone = new Intl.DateTimeFormat("en", { timeZone: timezone, timeZoneName: "longOffset" });
  const offset = (at: number) => {
    const name = zone.formatToParts(at).find((part) => part.type === "timeZoneName")!.value;
    const match = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(name);
    return match
      ? (match[1] === "-" ? -1 : 1) *
          (Number(match[2]) * 3600 + Number(match[3]) * 60 + Number(match[4] ?? 0)) *
          1000
      : 0;
  };
  return (at: number) => {
    const fold = offset(at - 36 * 3_600_000) - offset(at);
    return fold > 0 && local.format(at) === local.format(at - fold);
  };
}

export function nextFire(schedule: AutomationSchedule, after: number): number | null {
  switch (schedule.kind) {
    case "manual":
    case "signal":
      return null;
    case "once":
      return Date.parse(schedule.at) > after ? Date.parse(schedule.at) : null;
    case "interval":
      return after + schedule.seconds * 1000;
    case "cron": {
      const iterator = cron(schedule, after);
      const repeated = repeatedMinute(schedule.timezone);
      for (let i = 0; i < 2881; i++) {
        const candidate = iterator.next().getTime();
        if (!repeated(candidate)) return candidate;
      }
      throw new Error("Cron timezone transition exceeds the bounded search window");
    }
  }
}

export function initialFire(schedule: AutomationSchedule, now: number): number | null {
  return schedule.kind === "once" ? Date.parse(schedule.at) : nextFire(schedule, now);
}

/** Bounded by catch-up size plus a two-day timezone-transition window, never downtime length. */
export function dueFires(
  schedule: AutomationSchedule,
  next: number | null,
  now: number,
  policy: Pick<AutomationConfig["policy"], "missedRuns" | "maxCatchUp">,
): { fires: number[]; next: number | null; skipped: boolean } {
  if (next === null || next > now) return { fires: [], next, skipped: false };
  if (schedule.kind === "manual" || schedule.kind === "signal")
    return { fires: [], next: null, skipped: false };
  const future =
    schedule.kind === "interval"
      ? next + (Math.floor((now - next) / (schedule.seconds * 1000)) + 1) * schedule.seconds * 1000
      : nextFire(schedule, now);
  // A scheduler tick may be late by a second without constituting a missed run.
  if (policy.missedRuns === "skip" && now - next >= 1000)
    return { fires: [], next: future, skipped: true };
  const count = policy.missedRuns === "catch-up" ? policy.maxCatchUp : 1;
  const fires: number[] = [];
  if (schedule.kind === "interval") {
    const period = schedule.seconds * 1000;
    let candidate = next + Math.floor((now - next) / period) * period;
    while (candidate >= next && fires.length < count) {
      fires.unshift(candidate);
      candidate -= period;
    }
  } else if (schedule.kind === "cron") {
    const iterator = cron(schedule, now + 1);
    const repeated = repeatedMinute(schedule.timezone);
    for (let i = 0; fires.length < count && i < count + 2880; i++) {
      const candidate = iterator.prev().getTime();
      if (candidate < next) break;
      if (repeated(candidate)) continue;
      fires.unshift(candidate);
    }
  } else fires.push(next);
  return { fires, next: future, skipped: fires[0] !== next };
}
