export interface VaultEntry {
  name: string;
  relativePath: string;
  isDir: boolean;
  children: VaultEntry[];
}

export interface ActiveNote {
  name: string;
  relativePath: string;
  content: string;
}

export interface MovedNote {
  sourceRelativePath: string;
  note: ActiveNote;
}

export interface SearchHit {
  name: string;
  relativePath: string;
  excerpt: string;
}

export interface GraphNode {
  id: string;
  label: string;
  relativePath: string;
  kind: "folder" | "note";
  parentId: string | null;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: "link";
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}
