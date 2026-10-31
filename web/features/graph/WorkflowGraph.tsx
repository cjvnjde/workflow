import { useCallback, useEffect, useImperativeHandle, useMemo, useState, type Ref } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Handle,
  Position,
  MarkerType,
  BaseEdge,
  Background,
  Controls,
  useNodes,
  useNodesInitialized,
  useReactFlow,
  useStore,
  type Node,
  type NodeProps,
  type NodeChange,
  type OnNodeDrag,
  type EdgeProps,
} from "@xyflow/react";
import RoutedEdge, { type WorkflowEdge } from "./RoutedEdge.js";
import { resolveAgentSettings, type WorkflowRun } from "../../../src/contracts/index.js";
import { compositionLayout, routedPositions, type LayoutEdge } from "./graph-layout.js";
import { stepState } from "../execution/workflow-status.js";
import { executionLabel, isSourceWorkflow } from "../execution/execution-label.js";

type Point = { x: number; y: number };
type Positions = Record<string, Point>;
type GroupState = NonNullable<WorkflowRun["groups"]>[string];
type GraphNodeData = {
  label?: string;
  detail?: string;
  condition?: string;
  groupState?: GroupState;
  horizontal?: boolean;
  block?: string;
  visits?: number;
  maxVisits?: number;
  model?: string;
  thinking?: string;
  state?: string;
  current?: boolean;
};
type GraphNode = Node<GraphNodeData>;

export type WorkflowGraphHandle = { fit(): void };
export type WorkflowGraphProps = {
  run: WorkflowRun;
  selected?: string;
  onSelect: (id: string) => void;
  ref?: Ref<WorkflowGraphHandle>;
};

const storageKey = (id: string) => `workflow:graph:${id}`;
const motionDuration = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 250;

function loadPositions(id: string): Positions {
  const positions: Positions = {};
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storageKey(id)) ?? "{}");
    if (saved && typeof saved === "object") {
      for (const [nodeId, point] of Object.entries(saved)) {
        if (
          point &&
          typeof point === "object" &&
          "x" in point &&
          "y" in point &&
          typeof point.x === "number" &&
          typeof point.y === "number" &&
          Number.isFinite(point.x) &&
          Number.isFinite(point.y)
        ) {
          positions[nodeId] = { x: point.x, y: point.y };
        }
      }
    }
  } catch {
    /* Local layout storage is optional. */
  }
  return positions;
}

function WorkflowNode({ data }: NodeProps<GraphNode>) {
  return (
    <>
      <Handle type="target" position={data.horizontal ? Position.Left : Position.Top} />
      <div className="graph-label">
        <small>
          {data.block} · {data.visits}/{data.maxVisits} visits
        </small>
        <strong title={data.label}>{data.label}</strong>
        <span>
          {data.model}
          {data.thinking !== "code" ? ` · ${data.thinking}` : ""}
        </span>
        <b>{data.current ? "● working" : data.state}</b>
      </div>
      <Handle type="source" position={data.horizontal ? Position.Right : Position.Bottom} />
    </>
  );
}

function GroupNode({ data }: NodeProps<GraphNode>) {
  const state = data.groupState;
  return (
    <div className="composition-heading">
      <strong title={data.condition ? `Predicate: ${data.condition}` : undefined}>
        {data.label}
      </strong>
      <span>{data.detail}</span>
      {state && (
        <small>
          {state.state}
          {state.iteration ? ` · round ${state.iteration}` : ""}
          {state.decision && (
            <>
              {` · ${state.decision.route}`}
              {state.decision.result !== undefined ? ` (${state.decision.result})` : ""}
            </>
          )}
        </small>
      )}
    </div>
  );
}

function JunctionNode() {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
      <Handle id="return-input-top" type="target" position={Position.Top} />
      <Handle id="return-output-top" type="source" position={Position.Top} />
      <Handle id="return-input-bottom" type="target" position={Position.Bottom} />
      <Handle id="return-output-bottom" type="source" position={Position.Bottom} />
    </>
  );
}

function ReturnEdge(edge: EdgeProps<WorkflowEdge>) {
  const y = Number(edge.data?.returnY);
  const direction = Math.sign(edge.targetX - edge.sourceX) || -1;
  const radius = 8;
  const sourceCorner = y + Math.sign(edge.sourceY - y) * radius;
  const targetCorner = y + Math.sign(edge.targetY - y) * radius;
  const path = `M ${edge.sourceX} ${edge.sourceY} L ${edge.sourceX} ${sourceCorner} Q ${edge.sourceX} ${y} ${edge.sourceX + direction * radius} ${y} L ${edge.targetX - direction * radius} ${y} Q ${edge.targetX} ${y} ${edge.targetX} ${targetCorner} L ${edge.targetX} ${edge.targetY}`;
  return (
    <BaseEdge
      id={edge.id}
      path={path}
      style={edge.style}
      markerEnd={edge.markerEnd}
      interactionWidth={0}
      label={edge.label}
      labelX={(edge.sourceX + edge.targetX) / 2}
      labelY={y}
      labelStyle={edge.labelStyle}
      labelBgStyle={edge.labelBgStyle}
    />
  );
}

const nodeTypes = {
  workflow: WorkflowNode,
  "composition-group": GroupNode,
  junction: JunctionNode,
};
const edgeTypes = { obstacle: RoutedEdge, "loop-return": ReturnEdge };

function GraphCanvas({ run, selected, onSelect, ref }: WorkflowGraphProps) {
  const [positions, setPositions] = useState(() => loadPositions(run.id));
  const [presentation, setPresentation] = useState<
    Record<string, Pick<GraphNode, "measured" | "dragging">>
  >({});
  const [fitRequest, setFitRequest] = useState<{ nodes?: string[] }>({});
  const { fitView } = useReactFlow<GraphNode, WorkflowEdge>();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const initialized = useNodesInitialized();
  const measuredNodes = useNodes<GraphNode>();
  const layout = useMemo(
    () => (run.program?.structure ? compositionLayout(run.program.structure) : undefined),
    [run.program],
  );
  const routed = useMemo(() => routedPositions(run.plan), [run.plan]);
  const composed = !!layout;
  const fit = useCallback(() => setFitRequest({}), []);
  useImperativeHandle(ref, () => ({ fit }), [fit]);

  // React Flow measures both nodes and its container. Refit after either becomes
  // ready, and when an inspector or expanded workspace changes the canvas size.
  useEffect(() => {
    if (!width || !height || !initialized) return;
    void fitView({
      nodes: fitRequest.nodes?.map((id) => ({ id })),
      padding: fitRequest.nodes ? 0.3 : composed ? 0.07 : 0.18,
      maxZoom: 1.1,
      duration: motionDuration(),
    });
  }, [width, height, initialized, fitView, fitRequest, composed]);

  const nodes = useMemo<GraphNode[]>(() => {
    const placements = new Map(layout?.nodes.map((node) => [node.id, node]));
    const result: GraphNode[] = [
      ...(layout?.nodes
        .filter((node) => node.kind !== "step")
        .map((node): GraphNode => ({
          id: node.id,
          selected: selected === node.id,
          type: node.kind === "group" ? "composition-group" : node.kind,
          position: node.position,
          draggable: false,
          selectable: node.kind === "group",
          data: {
            label: node.label,
            detail: node.detail,
            condition: node.condition,
            groupState: run.groups?.[node.id],
            horizontal: true,
          },
          style: { width: node.width, height: node.height },
          className: node.kind === "group" ? "composition-group" : "composition-junction",
          zIndex: node.kind === "group" ? 0 : 1,
        })) ?? []),
      ...run.plan.nodes.map((node): GraphNode => {
        const block = run.blocks[node.block]?.definition;
        const settings = resolveAgentSettings(run.config.agent, block?.agent, node.agent);
        const status = stepState(run, node.id);
        const current = status === "running";
        const state = current ? "active" : status === "failed" ? "fail" : status;
        const placement = placements.get(node.id);
        return {
          id: node.id,
          selected: selected === node.id,
          type: "workflow",
          position: positions[node.id] ?? placement?.position ?? routed[node.id] ?? { x: 0, y: 0 },
          extent: placement?.extent,
          data: {
            block: node.block,
            visits: run.visits[node.id] ?? 0,
            maxVisits: node.maxVisits,
            label: node.label,
            model: block?.executor
              ? block.executor.kind === "code" && node.agent?.model
                ? `${executionLabel(block.executor)} · ${settings.model}`
                : executionLabel(block.executor)
              : (settings.model ?? "orchestrator chooses"),
            thinking:
              block?.executor && !(block.executor.kind === "code" && node.agent?.model)
                ? block.executor.kind
                : settings.thinking,
            state,
            current,
            horizontal: !!layout,
          },
          className: `workflow-node ${layout ? "composition-step" : ""} ${state}`,
          style: { width: placement?.width ?? 260, height: placement?.height ?? 184 },
        };
      }),
      {
        id: "$complete",
        position: positions.$complete ?? {
          x: layout ? layout.width + 96 : 60,
          y: layout
            ? (() => {
                const exit = placements.get(layout.exit)!;
                return exit.position.y + exit.height / 2 - 20;
              })()
            : Math.max(0, ...Object.values(routed).map((point) => point.y)) + 280,
        },
        data: { label: "✓ Complete" },
        className: "terminal complete",
        targetPosition: layout ? Position.Left : Position.Top,
      },
      ...(!layout
        ? [
            {
              id: "$failed",
              position: positions.$failed ?? {
                x: Math.max(0, ...Object.values(routed).map((point) => point.x)) + 380,
                y: 0,
              },
              data: { label: "× Stop / failed" },
              className: "terminal failed",
            },
          ]
        : []),
    ];
    for (const node of result) {
      const appearance = presentation[node.id];
      if (appearance) {
        node.measured = appearance.measured;
        node.dragging = appearance.dragging;
      }
    }
    return result;
  }, [layout, run, selected, positions, routed, presentation]);

  const obstacles = useMemo(() => {
    const measured = new Map(measuredNodes.map((node) => [node.id, node]));
    return nodes.map((node) => {
      const actual = measured.get(node.id);
      const position = actual?.position ?? node.position;
      return {
        x: position.x,
        y: position.y,
        width: actual?.measured?.width || Number(node.style?.width ?? 160),
        height:
          node.type === "composition-group"
            ? 48
            : actual?.measured?.height || Number(node.style?.height ?? 40),
      };
    });
  }, [nodes, measuredNodes]);

  const edges = useMemo<WorkflowEdge[]>(() => {
    type Connection = {
      from: string;
      target: string;
      outcome: string;
      label?: string;
      returnY?: number;
      returnSide?: "top" | "bottom";
    };
    const connections: Connection[] = layout
      ? [...layout.edges, { from: layout.exit, to: "$complete" }].map((edge: LayoutEdge) => ({
          from: edge.from,
          target: edge.to,
          outcome: edge.repeat ? "retry" : "pass",
          label: edge.label,
          returnY: edge.returnY,
          returnSide: edge.returnSide,
        }))
      : isSourceWorkflow(run)
        ? [
            ...new Map(
              (run.transitions ?? []).map((edge) => [
                `${edge.from}-${edge.to}-${edge.outcome}`,
                edge,
              ]),
            ).values(),
          ].map((edge) => ({
            from: edge.from,
            target: edge.to,
            outcome: edge.outcome,
          }))
        : run.plan.nodes.flatMap((node) =>
            Object.entries(node.on).map(([outcome, target]) => ({
              from: node.id,
              target,
              outcome,
            })),
          );
    return connections.map(({ from, target, outcome, label, returnY, returnSide }) => ({
      id: `${from}-${target}-${outcome}`,
      source: from,
      target,
      type: returnY !== undefined ? "loop-return" : "obstacle",
      sourceHandle: returnY !== undefined ? `return-output-${returnSide ?? "top"}` : undefined,
      targetHandle: returnY !== undefined ? `return-input-${returnSide ?? "top"}` : undefined,
      data: { returnY, obstacles },
      selectable: false,
      focusable: false,
      interactionWidth: 0,
      label: layout ? label : isSourceWorkflow(run) && outcome === "pass" ? "next" : outcome,
      animated: stepState(run, from) === "running",
      markerEnd: { type: MarkerType.ArrowClosed },
      style: {
        stroke:
          outcome === "pass"
            ? "var(--success)"
            : outcome === "retry"
              ? "var(--warning)"
              : "var(--muted-foreground)",
        strokeWidth: outcome === "fail" ? 1 : 2,
        strokeDasharray: outcome === "retry" ? "6 4" : undefined,
        pointerEvents: "none",
      },
      labelStyle: { fill: "var(--muted-foreground)", fontSize: 10 },
      labelBgStyle: { fill: "var(--card)" },
    }));
  }, [layout, run, obstacles]);

  const onNodesChange = useCallback((changes: NodeChange<GraphNode>[]) => {
    if (changes.some((change) => change.type === "position" && change.position)) {
      setPositions((previous) => {
        const next = { ...previous };
        for (const change of changes) {
          if (change.type === "position" && change.position) next[change.id] = change.position;
        }
        return next;
      });
    }
    if (
      changes.some(
        (change) =>
          change.type === "dimensions" ||
          (change.type === "position" && change.dragging !== undefined),
      )
    ) {
      setPresentation((previous) => {
        const next = { ...previous };
        for (const change of changes) {
          if (change.type === "dimensions" && change.dimensions) {
            next[change.id] = { ...next[change.id], measured: change.dimensions };
          } else if (change.type === "position" && change.dragging !== undefined) {
            next[change.id] = { ...next[change.id], dragging: change.dragging };
          }
        }
        return next;
      });
    }
  }, []);

  const remember: OnNodeDrag<GraphNode> = (_event, _node, moved) => {
    const next = { ...positions };
    for (const node of moved) next[node.id] = { ...node.position };
    setPositions(next);
    try {
      localStorage.setItem(storageKey(run.id), JSON.stringify(next));
    } catch {
      /* Quota or private browsing. */
    }
  };

  function resetLayout() {
    setPositions({});
    try {
      localStorage.removeItem(storageKey(run.id));
    } catch {
      /* Optional storage. */
    }
    fit();
  }

  function focusActive() {
    const active = run.plan.nodes
      .filter((node) => stepState(run, node.id) === "running")
      .map((node) => node.id);
    if (active.length === 1) onSelect(active[0]!);
    setFitRequest({ nodes: active });
  }

  return (
    <ReactFlow<GraphNode, WorkflowEdge>
      className="workflow-graph"
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      fitViewOptions={{ padding: layout ? 0.07 : 0.18, maxZoom: 1.1 }}
      nodesDraggable
      deleteKeyCode={null}
      nodesConnectable={false}
      minZoom={0.25}
      maxZoom={1.5}
      onNodeClick={(_event, node) => onSelect(node.id)}
      onNodesChange={onNodesChange}
      onNodeDragStop={remember}
    >
      <Background gap={22} color="var(--border)" />
      <Controls showInteractive={false} />
      <div className="graph-toolbar">
        <span>Drag blocks to arrange</span>
        {run.plan.nodes.some((node) => stepState(run, node.id) === "running") && (
          <button onClick={focusActive}>
            Focus active {(run.activeNodes?.length ?? 1) > 1 ? "steps" : "step"}
          </button>
        )}
        <button onClick={fit}>Fit workflow</button>
        <button onClick={resetLayout}>Reset layout</button>
      </div>
    </ReactFlow>
  );
}

export default function WorkflowGraph(props: WorkflowGraphProps) {
  return (
    <ReactFlowProvider key={props.run.id}>
      <GraphCanvas {...props} />
    </ReactFlowProvider>
  );
}
