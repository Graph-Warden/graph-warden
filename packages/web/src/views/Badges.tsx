import type { Node } from "@graph-warden/core";
import { formatScope } from "../graph.js";

export function Badges({ node }: { node: Node }) {
  return (
    <span className="badges">
      <span className="badge type">{node.type}</span>
      <span className={`badge scope ${node.scope.kind}`}>{formatScope(node.scope)}</span>
    </span>
  );
}
