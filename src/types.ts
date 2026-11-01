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

export interface SearchHit {
  name: string;
  relativePath: string;
  excerpt: string;
}
