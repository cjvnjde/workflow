import { test } from "vitest";
import assert from "node:assert/strict";
import {
  routeBetween,
  routedEdge,
  type Point,
  type Obstacle,
} from "../web/features/graph/edge-routing.js";
import { compositionLayout } from "../web/features/graph/graph-layout.js";
import {
  block,
  step,
  sequence,
  parallel,
  when,
  repeatUntil,
  describeFlow,
} from "../src/sdk/workflow-sdk.js";
function clear(points: Point[], boxes: Obstacle[]) {
  assert.ok(points.length >= 2);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!,
      b = points[i]!;
    assert.ok(a.x === b.x || a.y === b.y, "connections must be orthogonal");
    for (const r of boxes)
      assert.equal(
        a.x === b.x
          ? a.x > r.x &&
              a.x < r.x + r.width &&
              Math.max(a.y, b.y) > r.y &&
              Math.min(a.y, b.y) < r.y + r.height
          : a.y > r.y &&
              a.y < r.y + r.height &&
              Math.max(a.x, b.x) > r.x &&
              Math.min(a.x, b.x) < r.x + r.width,
        false,
        "route crossed a card",
      );
  }
}
test("orthogonal routes avoid staggered cards and reroute after dragging", () => {
  const boxes = [
    { x: 80, y: -40, width: 160, height: 120 },
    { x: 280, y: 60, width: 160, height: 180 },
  ];
  for (const end of [
    { x: 520, y: 0 },
    { x: 520, y: 180 },
    { x: -100, y: 180 },
  ])
    clear(routeBetween({ x: 0, y: 0 }, end, boxes), boxes);
  const moved = [{ x: 80, y: -140, width: 160, height: 120 }, boxes[1]!];
  const before = routeBetween({ x: 0, y: 0 }, { x: 520, y: 0 }, boxes),
    after = routeBetween({ x: 0, y: 0 }, { x: 520, y: 0 }, moved);
  clear(after, moved);
  assert.notDeepEqual(before, after);
});
test("self loops route outside their own card and covered ports fail explicitly", () => {
  const box = { x: 0, y: 0, width: 260, height: 184 };
  const route = routedEdge({ x: 130, y: 184 }, { x: 130, y: 0 }, "bottom", "top", [box]);
  assert.ok(route.path);
  assert.match(route.path, /L/);
  assert.deepEqual(routeBetween({ x: 10, y: 10 }, { x: 500, y: 10 }, [box]), []);
});
test("nested parallel, conditional and loop layouts reserve non-overlapping card bounds", () => {
  const job = () => block({ run: () => null });
  const flow = sequence(
    step("start", job()),
    parallel([
      sequence(step("a", job()), step("b", job()), step("c", job())),
      when("condition", () => true, step("d", job())),
      repeatUntil("repair", {
        body: parallel([step("e", job()), step("f", job())]),
        until: () => true,
        maxIterations: 3,
      }),
    ]),
    step("end", job()),
  );
  const layout = compositionLayout(describeFlow(flow));
  const cards = layout.nodes.filter((n) => n.kind === "step");
  for (const [i, a] of cards.entries())
    for (const b of cards.slice(i + 1))
      assert.ok(
        a.position.x + a.width <= b.position.x ||
          b.position.x + b.width <= a.position.x ||
          a.position.y + a.height <= b.position.y ||
          b.position.y + b.height <= a.position.y,
      );
  const obstacles = layout.nodes
    .filter((n) => n.kind !== "group")
    .map((n) => ({ ...n.position, width: n.width, height: n.height }));
  for (const edge of layout.edges.filter((e) => e.returnY === undefined)) {
    const a = layout.nodes.find((n) => n.id === edge.from)!,
      b = layout.nodes.find((n) => n.id === edge.to)!;
    clear(
      routeBetween(
        { x: a.position.x + a.width + 28, y: a.position.y + a.height / 2 },
        { x: b.position.x - 28, y: b.position.y + b.height / 2 },
        obstacles,
      ),
      obstacles,
    );
  }
});
