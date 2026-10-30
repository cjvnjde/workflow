export type Point = { x: number; y: number };
export type Obstacle = Point & { width: number; height: number };

/** Orthogonal visibility-grid A*: length plus bend cost, with clearance around cards. */
export function routeBetween(start: Point, end: Point, obstacles: Obstacle[]): Point[] {
  const boxes = obstacles.map((b) => ({
    x: b.x - 12,
    y: b.y - 12,
    width: b.width + 24,
    height: b.height + 24,
  }));
  const xs = [...new Set([start.x, end.x, ...boxes.flatMap((b) => [b.x, b.x + b.width])])].sort(
    (a, b) => a - b,
  );
  const ys = [...new Set([start.y, end.y, ...boxes.flatMap((b) => [b.y, b.y + b.height])])].sort(
    (a, b) => a - b,
  );
  const inside = (p: Point) =>
    boxes.some((b) => p.x > b.x && p.x < b.x + b.width && p.y > b.y && p.y < b.y + b.height);
  const blocked = (a: Point, b: Point) =>
    boxes.some((r) =>
      a.x === b.x
        ? a.x > r.x &&
          a.x < r.x + r.width &&
          Math.max(a.y, b.y) > r.y &&
          Math.min(a.y, b.y) < r.y + r.height
        : a.y > r.y &&
          a.y < r.y + r.height &&
          Math.max(a.x, b.x) > r.x &&
          Math.min(a.x, b.x) < r.x + r.width,
    );
  if (inside(start) || inside(end)) return [];
  const width = xs.length;
  const origin = ys.indexOf(start.y) * width + xs.indexOf(start.x);
  const target = ys.indexOf(end.y) * width + xs.indexOf(end.x);
  const point = (id: number): Point => ({
    x: xs[id % width]!,
    y: ys[Math.floor(id / width)]!,
  });
  type Item = { key: number; cost: number; score: number };
  const heap: Item[] = [];
  const push = (v: Item) => {
    heap.push(v);
    let i = heap.length - 1;
    while (i) {
      const p = (i - 1) >> 1;
      if (heap[p]!.score <= v.score) break;
      heap[i] = heap[p]!;
      i = p;
    }
    heap[i] = v;
  };
  const pop = () => {
    const first = heap[0]!;
    const last = heap.pop()!;
    if (heap.length) {
      let i = 0;
      while (i * 2 + 1 < heap.length) {
        let c = i * 2 + 1;
        if (c + 1 < heap.length && heap[c + 1]!.score < heap[c]!.score) c++;
        if (heap[c]!.score >= last.score) break;
        heap[i] = heap[c]!;
        i = c;
      }
      heap[i] = last;
    }
    return first;
  };
  const distance = (a: Point, b: Point) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
  const costs = new Map<number, number>([[origin * 3, 0]]),
    previous = new Map<number, number>();
  push({ key: origin * 3, cost: 0, score: distance(start, end) });
  while (heap.length) {
    const item = pop();
    if (costs.get(item.key) !== item.cost) continue;
    const id = Math.floor(item.key / 3),
      direction = item.key % 3,
      a = point(id);
    if (id === target) {
      const result: Point[] = [];
      let key: number | undefined = item.key;
      while (key !== undefined) {
        result.push(point(Math.floor(key / 3)));
        key = previous.get(key);
      }
      return simplify(result.reverse());
    }
    const x = id % width,
      y = Math.floor(id / width);
    for (const [nx, ny, dir] of [
      [x - 1, y, 1],
      [x + 1, y, 1],
      [x, y - 1, 2],
      [x, y + 1, 2],
    ] as const) {
      if (nx < 0 || nx >= width || ny < 0 || ny >= ys.length) continue;
      const next = ny * width + nx,
        b = point(next);
      if (blocked(a, b)) continue;
      const cost = item.cost + distance(a, b) + (direction && direction !== dir ? 24 : 0),
        key = next * 3 + dir;
      if (cost >= (costs.get(key) ?? Infinity)) continue;
      costs.set(key, cost);
      previous.set(key, item.key);
      push({ key, cost, score: cost + distance(b, end) });
    }
  }
  return [];
}
export function simplify(points: Point[]) {
  return points.filter(
    (p, i) =>
      !i ||
      i === points.length - 1 ||
      !(
        (points[i - 1]!.x === p.x && p.x === points[i + 1]!.x) ||
        (points[i - 1]!.y === p.y && p.y === points[i + 1]!.y)
      ),
  );
}
export function routedEdge(
  start: Point,
  end: Point,
  sourceSide: string,
  targetSide: string,
  obstacles: Obstacle[],
) {
  const offset = (p: Point, side: string): Point => ({
    x: p.x + (side === "right" ? 28 : side === "left" ? -28 : 0),
    y: p.y + (side === "bottom" ? 28 : side === "top" ? -28 : 0),
  });
  const middle = routeBetween(offset(start, sourceSide), offset(end, targetSide), obstacles);
  // Overlapping manually dragged cards can cover a port. Never invent a route through them.
  if (!middle.length) return { path: "", label: start };
  const points = simplify([start, ...middle, end]);
  let best = 0,
    label = start;
  points.slice(1).forEach((p, i) => {
    const a = points[i]!,
      length = Math.abs(p.x - a.x) + Math.abs(p.y - a.y);
    if (length > best) {
      best = length;
      label = { x: (p.x + a.x) / 2, y: (p.y + a.y) / 2 };
    }
  });
  return {
    path: points.map((p, i) => `${i ? "L" : "M"} ${p.x} ${p.y}`).join(" "),
    label,
  };
}
