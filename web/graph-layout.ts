import type { FlowStructure } from "../src/contracts.js";
import type { WorkflowPlan } from "../src/contracts.js";

type Point = { x: number; y: number };
export type LayoutNode = {
  id: string;
  kind: "step" | "group" | "junction";
  position: Point;
  width: number;
  height: number;
  label?: string;
  detail?: string;
  condition?: string;
  /** Absolute bounds of the nearest group; keep dragged blocks inside it. */
  extent?: [[number, number], [number, number]];
};
export type LayoutEdge = {
  from: string;
  to: string;
  label?: string;
  repeat?: boolean;
  /** Dedicated lane above a loop's contents. */
  returnY?: number;
  returnSide?: "top" | "bottom";
};
type Box = {
  width: number;
  height: number;
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  entry: string;
  exit: string;
};
const shifted = (box: Box, x: number, y: number): LayoutNode[] =>
  box.nodes.map((node) => ({
    ...node,
    position: { x: node.position.x + x, y: node.position.y + y },
    extent: node.extent
      ? [
          [node.extent[0][0] + x, node.extent[0][1] + y],
          [node.extent[1][0] + x, node.extent[1][1] + y],
        ]
      : undefined,
  }));
const shiftedEdges = (box: Box, y: number): LayoutEdge[] =>
  box.edges.map((edge) => ({
    ...edge,
    returnY: edge.returnY === undefined ? undefined : edge.returnY + y,
  }));

/** Lay out the composition's hierarchy, keeping branch lanes and loop boundaries visible. */
export function compositionLayout(root: FlowStructure): Box {
  if (root.kind === "step")
    return {
      width: 260,
      height: 184,
      nodes: [
        {
          id: root.id,
          kind: "step",
          position: { x: 0, y: 0 },
          width: 260,
          height: 184,
        },
      ],
      edges: [],
      entry: root.id,
      exit: root.id,
    };
  const children = root.children.map(compositionLayout);
  if (root.kind === "sequence") {
    const height = Math.max(...children.map((child) => child.height));
    let x = 0;
    const nodes: LayoutNode[] = [],
      edges: LayoutEdge[] = [];
    children.forEach((child, index) => {
      const y = (height - child.height) / 2;
      nodes.push(...shifted(child, x, y));
      edges.push(...shiftedEdges(child, y));
      if (index)
        edges.push({ from: children[index - 1]!.exit, to: child.entry, label: root.children[index - 1]?.kind === "loop" ? "true → continue" : undefined });
      x += child.width + 96;
    });
    return {
      width: x - 96,
      height,
      nodes,
      edges,
      entry: children[0]!.entry,
      exit: children.at(-1)!.exit,
    };
  }
  const contentWidth = Math.max(...children.map((child) => child.width));
  const contentHeight =
    children.reduce((total, child) => total + child.height, 0) +
    64 * (children.length - 1);
  const contentTop = root.kind === "loop" ? 108 : 88;
  const bypass = root.kind === "when" && children.length === 1;
  const width = contentWidth + 192,
    height = contentHeight + contentTop + (bypass ? 52 : 28);
  const middle = contentTop + contentHeight / 2;
  const entry = `$group:${root.id}:start`,
    exit = `$group:${root.id}:end`;
  const nodes: LayoutNode[] = [
    {
      id: root.id,
      kind: "group",
      position: { x: 0, y: 0 },
      width,
      height,
      label:
        root.kind === "loop"
          ? "Repeat until"
          : root.kind === "when"
            ? "Condition"
            : root.label,
      condition: root.condition,
      detail:
        root.kind === "loop"
          ? `True: exit · false: repeat · limit ${root.maxIterations}: fail`
          : root.kind === "parallel"
            ? `Up to ${root.concurrency} at once`
            : root.id,
    },
    {
      id: entry,
      kind: "junction",
      position: { x: 15, y: middle - 7 },
      width: 14,
      height: 14,
    },
    {
      id: exit,
      kind: "junction",
      position: { x: width - 29, y: middle - 7 },
      width: 14,
      height: 14,
    },
  ];
  const edges: LayoutEdge[] = [];
  let y = contentTop;
  children.forEach((child, index) => {
    const positioned = shifted(child, 96 + (contentWidth - child.width) / 2, y);
    for (const node of positioned)
      if (node.kind === "step" && !node.extent)
        node.extent = [
          [32, contentTop - 12],
          [width - 32, contentTop + contentHeight + 12],
        ];
    nodes.push(...positioned);
    edges.push(...shiftedEdges(child, y));
    edges.push({
      from: entry,
      to: child.entry,
      label: root.kind === "when" ? (index === 0 ? "yes" : "no") : undefined,
    });
    edges.push({ from: child.exit, to: exit });
    y += child.height + 64;
  });
  if (bypass)
    edges.push({
      from: entry,
      to: exit,
      label: "otherwise",
      returnY: height - 20,
      returnSide: "bottom",
    });
  if (root.kind === "loop")
    edges.push({
      from: exit,
      to: entry,
      label: "false → repeat (within limit)",
      repeat: true,
      returnY: 68,
      returnSide: "top",
    });
  return { width, height, nodes, edges, entry, exit };
}

/** Layout old explicit graphs by dependency depth; backward routes do not move nodes down forever. */
export function routedPositions(plan: WorkflowPlan): Record<string, Point> {
  const levels = new Map<string, number>(),
    visiting = new Set<string>();
  const visit = (id: string, depth: number) => {
    if (visiting.has(id) || id.startsWith("$") || depth > plan.nodes.length)
      return;
    if ((levels.get(id) ?? -1) >= depth) return;
    levels.set(id, depth);
    visiting.add(id);
    const node = plan.nodes.find((node) => node.id === id);
    if (node)
      for (const target of new Set(Object.values(node.on)))
        visit(target, depth + 1);
    visiting.delete(id);
  };
  visit(plan.entry, 0);
  const rows = new Map<number, string[]>();
  for (const node of plan.nodes) {
    const depth = levels.get(node.id) ?? 0;
    const row = rows.get(depth) ?? [];
    row.push(node.id);
    rows.set(depth, row);
  }
  return Object.fromEntries(
    [...rows].flatMap(([depth, row]) =>
      row.map((id, index) => [id, { x: index * 380, y: depth * 280 }]),
    ),
  );
}

export function findGroup(
  root: FlowStructure | undefined,
  id: string,
): FlowStructure | undefined {
  if (!root) return;
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findGroup(child, id);
    if (found) return found;
  }
}
