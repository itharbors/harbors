import { compareTableNames } from './names.js';
import type {
  Relationship,
  RelationshipEdgeLayout,
  RelationshipNodeLayout,
} from './types.js';

type RoutedEdges = {
  edges: RelationshipEdgeLayout[];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

const PARALLEL_EDGE_GAP = 12;

export function routeRelationshipEdges(
  relationships: Relationship[],
  nodes: RelationshipNodeLayout[],
): RoutedEdges {
  const nodeByName = new Map(nodes.map((node) => [node.name, node]));
  const sorted = relationships
    .filter((relationship) => (
      nodeByName.has(relationship.fromTable) && nodeByName.has(relationship.toTable)
    ))
    .slice()
    .sort((left, right) => compareTableNames(left.id, right.id));
  const groups = new Map<string, Relationship[]>();
  for (const relationship of sorted) {
    const names = [relationship.fromTable, relationship.toTable].sort(compareTableNames);
    const key = `${names[0]}\u0000${names[1]}`;
    const values = groups.get(key) ?? [];
    values.push(relationship);
    groups.set(key, values);
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const include = (points: Array<{ x: number; y: number }>): void => {
    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  };

  const edges = sorted.map((relationship) => {
    const from = nodeByName.get(relationship.fromTable)!;
    const to = nodeByName.get(relationship.toTable)!;
    const names = [relationship.fromTable, relationship.toTable].sort(compareTableNames);
    const group = groups.get(`${names[0]}\u0000${names[1]}`)!;
    const index = group.indexOf(relationship);
    const offset = (index - (group.length - 1) / 2) * PARALLEL_EDGE_GAP;
    const fromY = from.y + from.height / 2;
    const toY = to.y + to.height / 2;
    let path: string;
    let points: Array<{ x: number; y: number }>;

    if (from.name === to.name) {
      const right = from.x + from.width;
      const loopWidth = 36 + index * PARALLEL_EDGE_GAP;
      points = [
        { x: right, y: fromY },
        { x: right + loopWidth, y: fromY - 36 },
        { x: right + loopWidth, y: fromY + 36 },
        { x: right, y: fromY },
      ];
      path = `M ${points[0].x} ${points[0].y} C ${points[1].x} ${points[1].y} ${points[2].x} ${points[2].y} ${points[3].x} ${points[3].y}`;
    } else if (from.x === to.x) {
      const right = Math.max(from.x + from.width, to.x + to.width);
      const lane = right + 70 + offset;
      points = [
        { x: from.x + from.width, y: fromY },
        { x: lane, y: fromY },
        { x: lane, y: toY },
        { x: to.x + to.width, y: toY },
      ];
      path = polylinePath(points);
    } else {
      const targetIsRight = to.x > from.x;
      const fromX = targetIsRight ? from.x + from.width : from.x;
      const toX = targetIsRight ? to.x : to.x + to.width;
      const lane = (fromX + toX) / 2 + offset;
      points = [
        { x: fromX, y: fromY },
        { x: lane, y: fromY },
        { x: lane, y: toY },
        { x: toX, y: toY },
      ];
      path = polylinePath(points);
    }
    include(points);
    return {
      id: relationship.id,
      fromTable: relationship.fromTable,
      toTable: relationship.toTable,
      path,
    };
  });

  if (edges.length === 0) return { edges, minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { edges, minX, minY, maxX, maxY };
}

function polylinePath(points: Array<{ x: number; y: number }>): string {
  return points.map((point, index) => (
    `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`
  )).join(' ');
}
