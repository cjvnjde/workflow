import { BaseEdge, getSmoothStepPath, type Edge, type EdgeProps } from "@xyflow/react";
import { routedEdge, type Obstacle } from "./edge-routing.js";

export type RoutedEdgeData = {
  returnY?: number;
  obstacles: Obstacle[];
};
export type WorkflowEdge = Edge<RoutedEdgeData>;

export default function RoutedEdge(props: EdgeProps<WorkflowEdge>) {
  const routed = routedEdge(
    { x: props.sourceX, y: props.sourceY },
    { x: props.targetX, y: props.targetY },
    props.sourcePosition,
    props.targetPosition,
    props.data?.obstacles ?? [],
  );
  let path = routed.path;
  let { x: labelX, y: labelY } = routed.label;
  if (!path) [path, labelX, labelY] = getSmoothStepPath(props);

  return (
    <BaseEdge
      id={props.id}
      path={path}
      style={props.style}
      markerEnd={props.markerEnd}
      interactionWidth={0}
      label={props.label}
      labelX={labelX}
      labelY={labelY}
      labelStyle={props.labelStyle}
      labelBgStyle={props.labelBgStyle}
    />
  );
}
