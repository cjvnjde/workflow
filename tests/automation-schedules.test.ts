import assert from "node:assert/strict";
import { test } from "vitest";
import { dueFires, initialFire, nextFire } from "../src/core/automations/schedules.js";
import type { AutomationSchedule } from "../src/contracts/automation-schema.js";

const at = (value: string) => Date.parse(value);
const epoch = at("2026-11-03T12:00:00.000Z");
const interval = { kind: "interval", seconds: 60 } as const;
const latest = { missedRuns: "latest", maxCatchUp: 3 } as const;
const catchUp = { missedRuns: "catch-up", maxCatchUp: 3 } as const;

for (const kind of ["manual", "signal"] as const) {
  test(`${kind} schedules never manufacture timed work`, () => {
    assert.equal(initialFire({ kind }, epoch), null);
    assert.equal(nextFire({ kind }, epoch), null);
    assert.deepEqual(dueFires({ kind }, null, epoch, latest), {
      fires: [],
      next: null,
      skipped: false,
    });
    assert.deepEqual(dueFires({ kind }, epoch - 1, epoch, latest), {
      fires: [],
      next: null,
      skipped: false,
    });
  });
}

test("interval boundaries retain their original phase rather than drifting with late ticks", () => {
  const first = initialFire(interval, epoch)!;
  assert.equal(first, epoch + 60_000);
  assert.deepEqual(dueFires(interval, first, first - 1, latest), {
    fires: [],
    next: first,
    skipped: false,
  });
  assert.deepEqual(dueFires(interval, first, first, latest), {
    fires: [first],
    next: epoch + 120_000,
    skipped: false,
  });
  assert.deepEqual(dueFires(interval, first, first + 31_000, latest), {
    fires: [first],
    next: epoch + 120_000,
    skipped: false,
  });
});

test("latest and bounded catch-up collapse years of missed intervals without replaying the backlog", () => {
  const next = epoch + 60_000;
  const now = epoch + 100_000_000 * 60_000 + 17_000;
  const newest = now - 17_000;
  assert.deepEqual(dueFires(interval, next, now, latest), {
    fires: [newest],
    next: newest + 60_000,
    skipped: true,
  });
  assert.deepEqual(dueFires(interval, next, now, catchUp), {
    fires: [newest - 120_000, newest - 60_000, newest],
    next: newest + 60_000,
    skipped: true,
  });
  assert.deepEqual(dueFires(interval, next, epoch + 120_000, catchUp), {
    fires: [next, epoch + 120_000],
    next: epoch + 180_000,
    skipped: false,
  });
});

test("skip tolerates a subsecond tick delay but discards a missed interval", () => {
  const policy = { missedRuns: "skip", maxCatchUp: 3 } as const;
  assert.deepEqual(dueFires(interval, epoch, epoch + 999, policy), {
    fires: [epoch],
    next: epoch + 60_000,
    skipped: false,
  });
  assert.deepEqual(dueFires(interval, epoch, epoch + 1000, policy), {
    fires: [],
    next: epoch + 60_000,
    skipped: true,
  });
});

test("one-time schedules fire once, including missed dates under latest/catch-up", () => {
  const schedule = { kind: "once", at: new Date(epoch).toISOString() } as const;
  assert.equal(initialFire(schedule, epoch + 86_400_000), epoch);
  assert.equal(nextFire(schedule, epoch - 1), epoch);
  assert.equal(nextFire(schedule, epoch), null);
  for (const policy of [latest, catchUp]) {
    assert.deepEqual(dueFires(schedule, epoch, epoch + 86_400_000, policy), {
      fires: [epoch],
      next: null,
      skipped: false,
    });
    assert.deepEqual(dueFires(schedule, null, epoch + 172_800_000, policy), {
      fires: [],
      next: null,
      skipped: false,
    });
  }
  assert.deepEqual(dueFires(schedule, epoch, epoch + 1000, { ...latest, missedRuns: "skip" }), {
    fires: [],
    next: null,
    skipped: true,
  });
});

test("clock rollback never re-fires an interval whose next checkpoint is in the future", () => {
  const fired = dueFires(interval, epoch, epoch, latest);
  assert.deepEqual(dueFires(interval, fired.next, epoch - 3_600_000, latest), {
    fires: [],
    next: epoch + 60_000,
    skipped: false,
  });
  assert.deepEqual(dueFires(interval, fired.next, epoch, latest), {
    fires: [],
    next: epoch + 60_000,
    skipped: false,
  });
});

test("cron uses its configured timezone across spring and fall DST transitions", () => {
  const schedule = { kind: "cron", expression: "0 9 * * *", timezone: "America/New_York" } as const;
  const beforeSpring = at("2026-03-07T14:00:00.000Z");
  const afterSpring = nextFire(schedule, beforeSpring)!;
  assert.equal(afterSpring, at("2026-03-08T13:00:00.000Z"));
  assert.equal(afterSpring - beforeSpring, 23 * 3_600_000);
  const beforeFall = at("2026-10-31T13:00:00.000Z");
  const afterFall = nextFire(schedule, beforeFall)!;
  assert.equal(afterFall, at("2026-11-01T14:00:00.000Z"));
  assert.equal(afterFall - beforeFall, 25 * 3_600_000);
  assert.equal(
    nextFire({ ...schedule, timezone: "Asia/Kolkata" }, epoch),
    at("2026-11-04T03:30:00.000Z"),
  );
});

test("cron catch-up stays bounded and chronological across a DST discontinuity", () => {
  const schedule = { kind: "cron", expression: "0 9 * * *", timezone: "America/New_York" } as const;
  const result = dueFires(
    schedule,
    at("2025-01-01T14:00:00.000Z"),
    at("2026-03-09T13:00:00.000Z"),
    catchUp,
  );
  assert.deepEqual(result, {
    fires: [
      at("2026-03-07T14:00:00.000Z"),
      at("2026-03-08T13:00:00.000Z"),
      at("2026-03-09T13:00:00.000Z"),
    ],
    next: at("2026-03-10T13:00:00.000Z"),
    skipped: true,
  });
  assert.deepEqual(dueFires(schedule, result.next, at("2026-03-08T12:00:00.000Z"), catchUp), {
    fires: [],
    next: result.next,
    skipped: false,
  });
});

test("cron clock folds fire each wall minute once even during backward catch-up", () => {
  const schedule = {
    kind: "cron",
    expression: "30 1 * * *",
    timezone: "America/New_York",
  } as const;
  const first = nextFire(schedule, at("2026-11-01T04:00:00Z"))!;
  assert.equal(first, at("2026-11-01T05:30:00Z"));
  assert.equal(nextFire(schedule, first), at("2026-11-02T06:30:00Z"));
  assert.deepEqual(dueFires(schedule, first, at("2026-11-01T07:00:00Z"), catchUp).fires, [first]);
  assert.deepEqual(
    dueFires(
      { ...schedule, expression: "* * * * *" },
      at("2026-11-01T04:00:00Z"),
      at("2026-11-01T07:00:00Z"),
      catchUp,
    ).fires,
    [at("2026-11-01T05:58:00Z"), at("2026-11-01T05:59:00Z"), at("2026-11-01T07:00:00Z")],
  );
  assert.equal(
    nextFire({ ...schedule, expression: "* * * * *" }, at("2026-11-01T05:59:00Z")),
    at("2026-11-01T07:00:00Z"),
  );
});

test("a nonexistent spring wall time shifts forward without duplicate execution", () => {
  const schedule = {
    kind: "cron",
    expression: "30 2 * * *",
    timezone: "America/New_York",
  } as const;
  assert.equal(nextFire(schedule, at("2026-03-08T05:00:00Z")), at("2026-03-08T07:30:00Z"));
});

for (const schedule of [
  { kind: "cron", expression: "0 0 9 * * *", timezone: "UTC" },
  { kind: "cron", expression: "H 9 * * *", timezone: "UTC" },
  { kind: "cron", expression: "0 25 * * *", timezone: "UTC" },
  { kind: "cron", expression: "0 9 * * *", timezone: "Not/A_Timezone" },
] satisfies AutomationSchedule[]) {
  test(`invalid cron is rejected before saving: ${schedule.expression} ${schedule.timezone}`, () => {
    assert.throws(() => initialFire(schedule, epoch));
  });
}
