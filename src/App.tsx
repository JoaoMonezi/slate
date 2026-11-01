import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { filterSuggestionItems } from "@blocknote/core/extensions";
import { BlockNoteView } from "@blocknote/mantine";
import { getDefaultReactSlashMenuItems, SuggestionMenuController, useCreateBlockNote, useEditorChange } from "@blocknote/react";
import type { VaultEntry, SearchHit, ActiveNote, GraphData, GraphNode, MovedNote } from "./types";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import "./App.css";

const VAULT_STORAGE_KEY = "slate.vaultPath";

function TrashIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 6h12M8 6V4h4v2m-6 0 .7 10h6.6L14 6m-5 3v4m2-4v4" />
    </svg>
  );
}

function NoteEditor({
  pathKey,
  markdown,
  notes,
  onOpenNoteLink,
  onSave,
  onDraft,
  shouldSkipSave,
}: {
  pathKey: string;
  markdown: string;
  notes: VaultEntry[];
  onOpenNoteLink: (target: string) => void;
  onSave: (value: string, relativePath: string) => void;
  onDraft: (value: string) => void;
  shouldSkipSave: (relativePath: string) => boolean;
}) {
  const editor = useCreateBlockNote();
  const [linkPickerOpen, setLinkPickerOpen] = useState(false);
  const [linkQuery, setLinkQuery] = useState("");
  const linkSearchRef = useRef<HTMLInputElement>(null);
  const notesRef = useRef(notes);
  const hydrated = useRef(false);
  const pendingMarkdown = useRef(markdown);
  const timer = useRef<number | undefined>(undefined);
  const pathRef = useRef(pathKey);
  const pendingPath = useRef(pathKey);
  const saveRef = useRef(onSave);
  const draftRef = useRef(onDraft);
  const skipSaveRef = useRef(shouldSkipSave);
  pathRef.current = pathKey;
  saveRef.current = onSave;
  draftRef.current = onDraft;
  skipSaveRef.current = shouldSkipSave;
  notesRef.current = notes;

  useEffect(() => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
    pathRef.current = pathKey;
    pendingPath.current = pathKey;
    hydrated.current = false;
    const migratedMarkdown = wikiLinksToMarkdown(markdown, notesRef.current);
    const blocks = editor.tryParseMarkdownToBlocks(migratedMarkdown);
    editor.replaceBlocks(editor.document, blocks);
    pendingMarkdown.current = migratedMarkdown === markdown ? markdown : editor.blocksToMarkdownLossy();
    hydrated.current = true;
    if (pendingMarkdown.current !== markdown) {
      draftRef.current(pendingMarkdown.current);
      timer.current = window.setTimeout(() => {
        saveRef.current(pendingMarkdown.current, pendingPath.current);
      }, 350);
    }
  }, [editor, markdown, pathKey]);

  useEditorChange(() => {
    if (!hydrated.current) return;

    pendingMarkdown.current = editor.blocksToMarkdownLossy();
    pendingPath.current = pathRef.current;
    draftRef.current(pendingMarkdown.current);
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      saveRef.current(pendingMarkdown.current, pendingPath.current);
    }, 350);
  }, editor);

  useEffect(
    () => () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current);
      if (hydrated.current && !skipSaveRef.current(pendingPath.current)) {
        saveRef.current(pendingMarkdown.current, pendingPath.current);
      }
    },
    [],
  );

  const slashMenuItems = useCallback(async (query: string) => {
    const defaultItems = getDefaultReactSlashMenuItems(editor);
    const linkItem = {
      title: "Vincular nota",
      subtext: "Inserir um link para outra nota",
      aliases: ["link", "nota", "wikilink"],
      group: "Notas",
      onItemClick: () => {
        (editor.getExtension("suggestionMenu") as { clearQuery: () => void } | undefined)?.clearQuery();
        setLinkQuery("");
        setLinkPickerOpen(true);
      },
    };
    return filterSuggestionItems([linkItem, ...defaultItems], query);
  }, [editor]);

  useEffect(() => {
    if (linkPickerOpen) linkSearchRef.current?.focus();
  }, [linkPickerOpen]);

  const insertNoteLink = (note: VaultEntry) => {
    const sameName = notes.filter((candidate) => candidate.name.toLocaleLowerCase() === note.name.toLocaleLowerCase());
    const target = sameName.length > 1
      ? note.relativePath.replace(/\\/g, "/").replace(/\.md$/i, "")
      : note.name.replace(/\.md$/i, "");
    editor.focus();
    editor.createLink(noteLinkHref(target), displayNoteName(note.name));
    setLinkPickerOpen(false);
  };

  const normalizedLinkQuery = linkQuery.trim().toLocaleLowerCase();
  const filteredNotes = notes
    .filter((note) => !normalizedLinkQuery
      || displayNoteName(note.name).toLocaleLowerCase().includes(normalizedLinkQuery)
      || displayRelativePath(note.relativePath).toLocaleLowerCase().includes(normalizedLinkQuery))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  return (
    <div className="editor-shell" onClickCapture={(event) => {
      const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href*='#slate-note/'], a[href^='slate-note://note/']");
      if (!anchor) return;
      event.preventDefault();
      event.stopPropagation();
      const rawHref = anchor.getAttribute("href") ?? "";
      const encodedTarget = rawHref.startsWith("#slate-note/")
        ? rawHref.slice("#slate-note/".length)
        : new URL(anchor.href).pathname.replace(/^\//, "");
      const target = decodeURIComponent(encodedTarget);
      onOpenNoteLink(target);
    }}>
      <BlockNoteView editor={editor} theme="light" slashMenu={false}>
        <SuggestionMenuController triggerCharacter="/" getItems={slashMenuItems} />
      </BlockNoteView>
      {linkPickerOpen && (
        <div className="link-picker-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setLinkPickerOpen(false);
        }}>
          <section className="link-picker" role="dialog" aria-modal="true" aria-labelledby="link-picker-title">
            <div className="link-picker-heading">
              <h2 id="link-picker-title">Vincular nota</h2>
              <button className="icon-button" aria-label="Fechar" onClick={() => setLinkPickerOpen(false)}>×</button>
            </div>
            <input
              ref={linkSearchRef}
              className="link-picker-search"
              value={linkQuery}
              onChange={(event) => setLinkQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setLinkPickerOpen(false);
                if (event.key === "Enter" && filteredNotes[0]) insertNoteLink(filteredNotes[0]);
              }}
              placeholder="Buscar uma nota"
              aria-label="Buscar nota para vincular"
            />
            <div className="link-picker-list">
              {filteredNotes.length ? filteredNotes.map((note) => (
                <button className="link-picker-item" key={note.relativePath} onClick={() => insertNoteLink(note)}>
                  <span>{displayNoteName(note.name)}</span>
                  <small>{displayRelativePath(note.relativePath)}</small>
                </button>
              )) : <p className="muted-copy">Nenhuma nota encontrada.</p>}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function flattenFolders(entries: VaultEntry[], prefix = ""): VaultEntry[] {
  return entries.flatMap((entry) => {
    if (!entry.isDir) return [];
    const current = { ...entry, relativePath: entry.relativePath || prefix };
    return [current, ...flattenFolders(entry.children, current.relativePath)];
  });
}

function flattenNotes(entries: VaultEntry[]): VaultEntry[] {
  return entries.flatMap((entry) => entry.isDir ? flattenNotes(entry.children) : [entry]);
}

function findExistingDraft(entries: VaultEntry[]) {
  const draftFolder = entries.find((entry) => entry.isDir && entry.name.toLocaleLowerCase() === "draft");
  const drafts = draftFolder?.children.filter((entry) => !entry.isDir && entry.name.toLocaleLowerCase().endsWith(".md")) ?? [];
  if (!drafts.length) return undefined;

  const numberedDrafts = drafts
    .map((entry) => ({ entry, number: /^Rascunho\s+(\d+)\.md$/i.exec(entry.name)?.[1] }))
    .filter((item): item is { entry: VaultEntry; number: string } => item.number !== undefined)
    .sort((left, right) => Number(right.number) - Number(left.number));
  return numberedDrafts[0]?.entry ?? drafts[drafts.length - 1];
}

function normalizeNoteTarget(target: string) {
  return target.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\//, "").replace(/\.md$/i, "").toLocaleLowerCase();
}

function resolveNoteEntry(target: string, notes: VaultEntry[]) {
  const normalized = normalizeNoteTarget(target);
  const exactPath = notes.find((note) => normalizeNoteTarget(note.relativePath) === normalized);
  if (exactPath) return exactPath;
  const matches = notes.filter((note) => normalizeNoteTarget(note.name) === normalized);
  return matches.length === 1 ? matches[0] : undefined;
}

function noteLinkHref(target: string) {
  return `#slate-note/${encodeURIComponent(target)}`;
}

function wikiLinksToMarkdown(markdown: string, notes: VaultEntry[]) {
  const localLinks = markdown.replace(/\]\(slate-note:\/\/note\/([^)]+)\)/gi, "](#slate-note/$1)");
  return localLinks.replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (whole, rawTarget: string, alias?: string) => {
    const target = rawTarget.trim();
    const note = resolveNoteEntry(target, notes);
    if (!note) return whole;
    const duplicateNames = notes.filter((candidate) => candidate.name.toLocaleLowerCase() === note.name.toLocaleLowerCase()).length > 1;
    const stableTarget = duplicateNames
      ? note.relativePath.replace(/\\/g, "/").replace(/\.md$/i, "")
      : note.name.replace(/\.md$/i, "");
    const label = (alias?.trim() || displayNoteName(note.name)).replace(/([\\[\]])/g, "\\$1");
    return `[${label}](${noteLinkHref(stableTarget)})`;
  });
}

function displayFolderName(name: string) {
  return name === "Draft" ? "Rascunhos" : name;
}

function displayNoteName(name: string) {
  return name.replace(/^Draft-/i, "Rascunho-").replace(/\.md$/i, "");
}

function displayRelativePath(path: string) {
  return path.split("/").map((part) => part.toLowerCase().endsWith(".md")
    ? displayNoteName(part)
    : displayFolderName(part)).join("/");
}

function FolderTree({
  entries,
  selectedFolder,
  onSelectFolder,
  onOpenNote,
  onRenameNote,
  onDeleteNote,
  onNoteContextMenu,
  selectedNotes,
  onToggleSelection,
}: {
  entries: VaultEntry[];
  selectedFolder: string;
  onSelectFolder: (path: string) => void;
  onOpenNote: (path: string) => void;
  onRenameNote: (path: string) => void;
  onDeleteNote: (path: string) => void;
  onNoteContextMenu: (path: string, x: number, y: number) => void;
  selectedNotes: Set<string>;
  onToggleSelection: (path: string) => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(["Draft"]));

  const renderEntries = (nodes: VaultEntry[], depth = 0) =>
    nodes.map((node) => {
      const isExpanded = expanded.has(node.relativePath);
      if (node.isDir) {
        return (
          <div className="tree-node" key={node.relativePath}>
            <div
              className={`tree-row folder-row ${selectedFolder === node.relativePath ? "selected" : ""}`}
              style={{ paddingLeft: `${12 + depth * 16}px` }}
            >
              <button
                className="tree-caret"
                aria-label={isExpanded ? "Recolher pasta" : "Expandir pasta"}
                onClick={() =>
                  setExpanded((current) => {
                    const next = new Set(current);
                    if (next.has(node.relativePath)) next.delete(node.relativePath);
                    else next.add(node.relativePath);
                    return next;
                  })
                }
              >
                {isExpanded ? "⌄" : "›"}
              </button>
              <button
                className="tree-label"
                onClick={() => {
                  onSelectFolder(node.relativePath);
                  setExpanded((current) => new Set(current).add(node.relativePath));
                }}
                title={`Escolher ${displayFolderName(node.name)} como destino da nota`}
              >
                <span className="tree-icon">▱</span>
                <span>{displayFolderName(node.name)}</span>
              </button>
            </div>
            {isExpanded && node.children.length > 0 && (
              <div>{renderEntries(node.children, depth + 1)}</div>
            )}
          </div>
        );
      }

      return (
        <div
          className={`tree-file-item ${selectedNotes.has(node.relativePath) ? "selected" : ""}`}
          key={node.relativePath}
          style={{ paddingLeft: `${28 + depth * 16}px` }}
          onContextMenu={(event) => {
            event.preventDefault();
            onNoteContextMenu(node.relativePath, event.clientX, event.clientY);
          }}
        >
          <input
            type="checkbox"
            className="tree-note-checkbox"
            checked={selectedNotes.has(node.relativePath)}
            onChange={() => onToggleSelection(node.relativePath)}
            aria-label={`Selecionar ${displayNoteName(node.name)}`}
          />
          <button
            className="tree-row file-row"
            onClick={() => onOpenNote(node.relativePath)}
            onDoubleClick={() => onRenameNote(node.relativePath)}
            title={displayRelativePath(node.relativePath)}
          >
            <span className="tree-icon file-icon">·</span>
            <span className="tree-label">{displayNoteName(node.name)}</span>
          </button>
          <button
            className="tree-delete-button"
            onClick={() => onDeleteNote(node.relativePath)}
            aria-label={`Apagar ${displayNoteName(node.name)}`}
            title="Apagar arquivo"
          >
            <TrashIcon />
          </button>
        </div>
      );
    });

  return <div className="tree-list">{renderEntries(entries)}</div>;
}

function GraphView({
  data,
  highlightedPaths,
  onOpenNote,
}: {
  data: GraphData;
  highlightedPaths: Set<string>;
  onOpenNote: (path: string) => void;
}) {
  const layout = useMemo(() => {
    const children = new Map<string, GraphNode[]>();
    for (const node of data.nodes) {
      if (!node.parentId) continue;
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node);
      children.set(node.parentId, siblings);
    }
    for (const siblings of children.values()) {
      siblings.sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === "folder" ? -1 : 1;
        return left.label.localeCompare(right.label);
      });
    }

    const positions = new Map<string, { x: number; y: number; depth: number }>();
    const root = data.nodes.find((node) => node.parentId === null);
    let row = 0;
    const place = (node: GraphNode, depth: number): number => {
      const descendants = (children.get(node.id) ?? []).map((child) => place(child, depth + 1));
      const y = descendants.length
        ? descendants.reduce((sum, value) => sum + value, 0) / descendants.length
        : 44 + row++ * 70;
      positions.set(node.id, { x: 30 + depth * 208, y, depth });
      return y;
    };
    if (root) place(root, 0);
    const hierarchy = data.nodes.flatMap((node) => {
      if (!node.parentId) return [];
      const parent = positions.get(node.parentId);
      const child = positions.get(node.id);
      return parent && child ? [{ parent, child, key: node.id }] : [];
    });
    const width = Math.max(420, ...[...positions.values()].map((position) => position.x + 190));
    const height = Math.max(160, row * 70 + 45);
    return { positions, hierarchy, width, height };
  }, [data]);

  return (
    <div className="graph-view">
      <div className="graph-legend">
        <span><i className="legend-folder" /> Pastas e notas</span>
        <span><i className="legend-link" /> Links entre notas</span>
        <span>{data.nodes.filter((node) => node.kind === "note").length} notas · {data.edges.length} links</span>
      </div>
      <div className="graph-canvas">
        <svg width={layout.width} height={layout.height} role="img" aria-label="Árvore de pastas e links entre notas">
          <defs>
            <marker id="graph-link-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M 0 0 L 10 5 L 0 10 z" className="graph-arrowhead" />
            </marker>
          </defs>
          {layout.hierarchy.map(({ parent, child, key }) => (
            <path
              key={`tree-${key}`}
              d={`M ${parent.x + 158} ${parent.y + 17} C ${parent.x + 188} ${parent.y + 17}, ${child.x - 30} ${child.y + 17}, ${child.x} ${child.y + 17}`}
              className="graph-tree-edge"
            />
          ))}
          {data.edges.map((edge) => {
            const source = layout.positions.get(edge.source);
            const target = layout.positions.get(edge.target);
            if (!source || !target) return null;
            const bend = Math.max(44, Math.abs(target.x - source.x) * 0.38);
            return (
              <path
                key={`${edge.source}-${edge.target}`}
                d={`M ${source.x + 158} ${source.y + 17} C ${source.x + 158 + bend} ${source.y + 17}, ${target.x - bend} ${target.y + 17}, ${target.x} ${target.y + 17}`}
                className="graph-link-edge"
                markerEnd="url(#graph-link-arrow)"
              />
            );
          })}
          {data.nodes.map((node) => {
            const position = layout.positions.get(node.id);
            if (!position) return null;
            const isNote = node.kind === "note";
            const selected = highlightedPaths.has(node.relativePath);
            const nodeLabel = isNote ? displayNoteName(node.label) : displayFolderName(node.label);
            return (
              <g
                key={node.id}
                transform={`translate(${position.x}, ${position.y})`}
                className={`graph-node ${isNote ? "note" : "folder"} ${selected ? "highlighted" : ""} ${isNote ? "clickable" : ""}`}
                onClick={isNote ? () => onOpenNote(node.relativePath) : undefined}
                onKeyDown={isNote ? (event) => { if (event.key === "Enter" || event.key === " ") onOpenNote(node.relativePath); } : undefined}
                tabIndex={isNote ? 0 : undefined}
                role={isNote ? "button" : undefined}
                aria-label={isNote ? `Abrir nota ${node.label}` : undefined}
              >
                <rect width="158" height="35" rx="8" />
                <text x="12" y="22">{isNote ? "▤" : "▱"}</text>
                <text x="32" y="22" className="graph-node-label">
                  {nodeLabel.length > 18 ? `${nodeLabel.slice(0, 17)}…` : nodeLabel}
                </text>
                <title>{nodeLabel} · {displayRelativePath(node.relativePath) || "Slate"}</title>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

function App() {
  const [vaultPath, setVaultPath] = useState(() => localStorage.getItem(VAULT_STORAGE_KEY) ?? "");
  const [openNotes, setOpenNotes] = useState<ActiveNote[]>([]);
  const [activePathKey, setActivePathKey] = useState("");
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [graphData, setGraphData] = useState<GraphData>({ nodes: [], edges: [] });
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMode, setSearchMode] = useState<"results" | "tree">("results");
  const [searchBusy, setSearchBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState("Draft");
  const [newFolderName, setNewFolderName] = useState("");
  const [deleteTargets, setDeleteTargets] = useState<string[]>([]);
  const [deletingNote, setDeletingNote] = useState(false);
  const [selectedNotePaths, setSelectedNotePaths] = useState<Set<string>>(new Set());
  const [noteContextMenu, setNoteContextMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renamingNote, setRenamingNote] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const startupVault = useRef("");
  const initializingVault = useRef(false);
  const activePath = useRef("");
  const currentContent = useRef("");
  const saveQueue = useRef<Promise<void>>(Promise.resolve());
  const blockedSavePaths = useRef(new Set<string>());

  const activeNote = openNotes.find((note) => note.relativePath === activePathKey) ?? null;
  const noteEntries = useMemo(() => flattenNotes(entries), [entries]);
  activePath.current = activeNote?.relativePath ?? "";

  const refreshTree = useCallback(async (path: string) => {
    const nextEntries = await invoke<VaultEntry[]>("list_vault", { vaultPath: path });
    const nextGraph = await invoke<GraphData>("get_graph_data", { vaultPath: path })
      .catch((): GraphData => ({ nodes: [], edges: [] }));
    setEntries(nextEntries);
    setGraphData(nextGraph);
    return nextEntries;
  }, []);

  const persistNote = useCallback((path: string, relativePath: string, content: string) => {
    const pending = saveQueue.current
      .catch(() => undefined)
      .then(() => invoke<void>("save_note", { vaultPath: path, relativePath, content }));
    saveQueue.current = pending;
    return pending;
  }, []);

  const selectNoteTab = useCallback((note: ActiveNote) => {
    blockedSavePaths.current.delete(note.relativePath);
    setOpenNotes((current) => {
      const exists = current.some((item) => item.relativePath === note.relativePath);
      return exists
        ? current.map((item) => item.relativePath === note.relativePath ? note : item)
        : [...current, note];
    });
    setActivePathKey(note.relativePath);
    activePath.current = note.relativePath;
    currentContent.current = note.content;
    setMenuOpen(false);
    setSearchOpen(false);
  }, []);

  useEffect(() => {
    if (!noteContextMenu) return;
    const closeMenu = () => setNoteContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNoteContextMenu(null);
    };
    window.addEventListener("click", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [noteContextMenu]);

  const initializeDefaultVault = useCallback(async () => {
    if (vaultPath || initializingVault.current) return;
    initializingVault.current = true;
    setLoading(true);
    setError("");
    try {
      const path = await invoke<string>("ensure_default_vault");
      localStorage.setItem(VAULT_STORAGE_KEY, path);
      setVaultPath(path);
    } catch (cause) {
      setError(String(cause));
      initializingVault.current = false;
    } finally {
      setLoading(false);
    }
  }, [vaultPath]);

  const loadNote = useCallback(
    async (relativePath: string) => {
      if (!vaultPath) return;
      setLoading(true);
      setError("");
      try {
        if (activePath.current) {
          await persistNote(vaultPath, activePath.current, currentContent.current);
        }
        const note = await invoke<ActiveNote>("read_note", { vaultPath, relativePath });
        selectNoteTab(note);
      } catch (cause) {
        setError(String(cause));
      } finally {
        setLoading(false);
      }
    },
    [persistNote, selectNoteTab, vaultPath],
  );

  const createDraft = useCallback(
    async (path = vaultPath) => {
      if (!path) return;
      setError("");
      setLoading(true);
      try {
        if (activePath.current && path === vaultPath) {
          await persistNote(path, activePath.current, currentContent.current);
        }
        const note = await invoke<ActiveNote>("create_draft", { vaultPath: path });
        await refreshTree(path);
        selectNoteTab(note);
      } catch (cause) {
        setError(String(cause));
      } finally {
        setLoading(false);
      }
    },
    [persistNote, refreshTree, selectNoteTab, vaultPath],
  );

  useEffect(() => {
    if (!vaultPath) {
      void initializeDefaultVault();
      return;
    }
    if (startupVault.current === vaultPath) return;
    startupVault.current = vaultPath;
    void (async () => {
      try {
        const currentEntries = await refreshTree(vaultPath);
        const existingDraft = findExistingDraft(currentEntries);
        if (existingDraft) {
          setLoading(true);
          try {
            const note = await invoke<ActiveNote>("read_note", {
              vaultPath,
              relativePath: existingDraft.relativePath,
            });
            selectNoteTab(note);
          } finally {
            setLoading(false);
          }
        } else {
          await createDraft(vaultPath);
        }
      } catch (cause) {
        setError(String(cause));
        setVaultPath("");
        localStorage.removeItem(VAULT_STORAGE_KEY);
      }
    })();
  }, [createDraft, initializeDefaultVault, refreshTree, selectNoteTab, vaultPath]);

  useEffect(() => {
    if (!vaultPath || !searchOpen || !searchQuery.trim()) {
      setSearchHits([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setSearchBusy(true);
      try {
        const results = await invoke<SearchHit[]>("search_notes", {
          vaultPath,
          query: searchQuery.trim(),
        });
        if (!cancelled) setSearchHits(results);
      } catch (cause) {
        if (!cancelled) setError(String(cause));
      } finally {
        if (!cancelled) setSearchBusy(false);
      }
    }, 220);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [searchOpen, searchQuery, vaultPath]);

  const folders = useMemo(() => flattenFolders(entries), [entries]);
  const deleteTargetNames = deleteTargets.map((path) => displayNoteName(
    openNotes.find((note) => note.relativePath === path)?.name ?? path.split("/").pop() ?? "nota",
  ));
  const canMoveSelected = [...selectedNotePaths].some((path) => {
    const separator = path.lastIndexOf("/");
    const parent = separator >= 0 ? path.slice(0, separator) : "";
    return parent !== selectedFolder;
  });

  function toggleNoteSelection(path: string) {
    setSelectedNotePaths((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function chooseVault() {
    if (activePath.current && vaultPath) {
      await persistNote(vaultPath, activePath.current, currentContent.current).catch(() => undefined);
    }
    const selected = await open({ directory: true, multiple: false, title: "Escolher pasta de notas" });
    if (typeof selected !== "string") return;
    localStorage.setItem(VAULT_STORAGE_KEY, selected);
    startupVault.current = "";
    setVaultPath(selected);
    setOpenNotes([]);
    setActivePathKey("");
    setSelectedNotePaths(new Set());
    activePath.current = "";
    currentContent.current = "";
    setError("");
  }

  async function saveMarkdown(relativePath: string, content: string) {
    if (!vaultPath || !relativePath || blockedSavePaths.current.has(relativePath)) return;
    if (activePath.current === relativePath) currentContent.current = content;
    try {
      await persistNote(vaultPath, relativePath, content);
    } catch (cause) {
      if (activePath.current === relativePath) {
        setError(String(cause));
      }
      return;
    }
    try {
      setGraphData(await invoke<GraphData>("get_graph_data", { vaultPath }));
    } catch (cause) {
      if (searchOpen && searchMode === "tree") {
        setError(`Não foi possível atualizar a árvore: ${String(cause)}`);
      }
    }
  }

  async function organizeNote() {
    if (!activeNote || !selectedFolder || selectedFolder === "Draft") return;
    setError("");
    try {
      const sourcePath = activeNote.relativePath;
      await persistNote(vaultPath, activeNote.relativePath, currentContent.current);
      const moved = await invoke<ActiveNote>("move_note", {
        vaultPath,
        sourceRelativePath: activeNote.relativePath,
        destinationRelativePath: selectedFolder,
      });
      await refreshTree(vaultPath);
      setOpenNotes((current) => current.map((note) => note.relativePath === activeNote.relativePath ? moved : note));
      setSelectedNotePaths((current) => {
        if (!current.has(sourcePath)) return current;
        const next = new Set(current);
        next.delete(sourcePath);
        next.add(moved.relativePath);
        return next;
      });
      setActivePathKey(moved.relativePath);
      activePath.current = moved.relativePath;
      currentContent.current = moved.content;
      setSelectedFolder("Draft");
      setMenuOpen(false);
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function addFolder() {
    if (!vaultPath || !newFolderName.trim()) return;
    try {
      await invoke("create_folder", {
        vaultPath,
        parentRelativePath: "",
        name: newFolderName.trim(),
      });
      setNewFolderName("");
      await refreshTree(vaultPath);
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function moveSelectedNotes() {
    if (selectedNotePaths.size === 0 || !vaultPath || !selectedFolder || !canMoveSelected) return;
    const sourcePaths = [...selectedNotePaths];
    setError("");
    try {
      if (sourcePaths.includes(activePath.current)) {
        await persistNote(vaultPath, activePath.current, currentContent.current);
      }
      const moved = await invoke<MovedNote[]>("move_notes", {
        vaultPath,
        sourceRelativePaths: sourcePaths,
        destinationRelativePath: selectedFolder,
      });
      const movedBySource = new Map(moved.map((item) => [item.sourceRelativePath, item.note]));
      setOpenNotes((current) => current.map((note) => movedBySource.get(note.relativePath) ?? note));
      const movedActive = movedBySource.get(activePath.current);
      if (movedActive) {
        setActivePathKey(movedActive.relativePath);
        activePath.current = movedActive.relativePath;
        currentContent.current = movedActive.content;
      }
      await refreshTree(vaultPath);
      setSelectedNotePaths(new Set());
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function copySelectedNotes() {
    if (selectedNotePaths.size === 0 || !vaultPath || !selectedFolder) return;
    const sourcePaths = [...selectedNotePaths];
    setError("");
    try {
      if (sourcePaths.includes(activePath.current)) {
        await persistNote(vaultPath, activePath.current, currentContent.current);
      }
      await invoke<void>("copy_notes", {
        vaultPath,
        sourceRelativePaths: sourcePaths,
        destinationRelativePath: selectedFolder,
      });
      await refreshTree(vaultPath);
      setSelectedNotePaths(new Set());
    } catch (cause) {
      setError(String(cause));
    }
  }

  async function closeNoteTab(relativePath: string) {
    const closingIndex = openNotes.findIndex((note) => note.relativePath === relativePath);
    if (closingIndex < 0) return;
    if (relativePath === activePath.current && vaultPath) {
      await persistNote(vaultPath, relativePath, currentContent.current).catch((cause) => setError(String(cause)));
    }
    const remaining = openNotes.filter((note) => note.relativePath !== relativePath);
    setOpenNotes(remaining);
    if (activePathKey === relativePath) {
      const next = remaining[Math.min(closingIndex, remaining.length - 1)];
      if (next) {
        setActivePathKey(next.relativePath);
        activePath.current = next.relativePath;
        currentContent.current = next.content;
      } else {
        setActivePathKey("");
        activePath.current = "";
        currentContent.current = "";
      }
    }
  }

  function openNoteContextMenu(path: string, x: number, y: number) {
    setNoteContextMenu({
      path,
      x: Math.min(x, window.innerWidth - 190),
      y: Math.min(y, window.innerHeight - 110),
    });
  }

  function startRenameNote(path: string) {
    const name = openNotes.find((note) => note.relativePath === path)?.name
      ?? noteEntries.find((note) => note.relativePath === path)?.name
      ?? path.split("/").pop()
      ?? "Nota.md";
    setRenameName(displayNoteName(name));
    setRenameTarget(path);
    setNoteContextMenu(null);
    setError("");
  }

  async function confirmRenameNote() {
    const sourcePath = renameTarget;
    const nextName = renameName.trim();
    if (!sourcePath || !vaultPath || !nextName || renamingNote) return;

    const wasActive = activePath.current === sourcePath;
    setRenamingNote(true);
    setError("");
    try {
      if (wasActive) {
        await persistNote(vaultPath, sourcePath, currentContent.current);
        blockedSavePaths.current.add(sourcePath);
      }
      const renamed = await invoke<ActiveNote>("rename_note", {
        vaultPath,
        relativePath: sourcePath,
        newName: nextName,
      });
      blockedSavePaths.current.delete(renamed.relativePath);
      await refreshTree(vaultPath);
      setOpenNotes((current) => current.map((note) => note.relativePath === sourcePath ? renamed : note));
      setSelectedNotePaths((current) => {
        if (!current.has(sourcePath)) return current;
        const next = new Set(current);
        next.delete(sourcePath);
        next.add(renamed.relativePath);
        return next;
      });
      setSearchHits((current) => current.map((hit) => hit.relativePath === sourcePath
        ? { ...hit, name: renamed.name, relativePath: renamed.relativePath }
        : hit));
      if (wasActive) {
        setActivePathKey(renamed.relativePath);
        activePath.current = renamed.relativePath;
        currentContent.current = renamed.content;
      }
      setRenameTarget(null);
    } catch (cause) {
      if (wasActive) blockedSavePaths.current.delete(sourcePath);
      setError(String(cause));
    } finally {
      setRenamingNote(false);
    }
  }

  async function confirmDeleteNote() {
    if (deleteTargets.length === 0 || !vaultPath || deletingNote) return;
    const paths = [...deleteTargets];
    const pathSet = new Set(paths);
    const activeIndex = openNotes.findIndex((note) => note.relativePath === activePathKey);
    const activeWillBeDeleted = pathSet.has(activePathKey);
    paths.forEach((path) => blockedSavePaths.current.add(path));
    setDeletingNote(true);
    setError("");
    try {
      await invoke<void>("delete_notes", { vaultPath, relativePaths: paths });
      setDeleteTargets([]);
      setSelectedNotePaths(new Set());
      const remaining = openNotes.filter((note) => !pathSet.has(note.relativePath));
      setOpenNotes(remaining);
      setSearchHits((current) => current.filter((hit) => !pathSet.has(hit.relativePath)));
      if (activeWillBeDeleted) {
        const next = remaining[Math.min(Math.max(activeIndex, 0), remaining.length - 1)];
        if (next) {
          setActivePathKey(next.relativePath);
          activePath.current = next.relativePath;
          currentContent.current = next.content;
        } else {
          setActivePathKey("");
          activePath.current = "";
          currentContent.current = "";
        }
      }
      await refreshTree(vaultPath);
    } catch (cause) {
      paths.forEach((path) => blockedSavePaths.current.delete(path));
      if (pathSet.has(activePath.current)) {
        await persistNote(vaultPath, activePath.current, currentContent.current).catch(() => undefined);
      }
      setError(String(cause));
    } finally {
      setDeletingNote(false);
    }
  }

  async function showNotesFolder() {
    if (!vaultPath) return;
    try {
      await openPath(vaultPath);
    } catch (cause) {
      setError(`Não foi possível abrir a pasta de notas: ${String(cause)}`);
    }
  }

  function tabLabel(note: ActiveNote) {
    return displayNoteName(note.name);
  }

  return (
    <main className="slate-app">
      <header className={`topbar ${menuOpen || searchOpen ? "with-brand" : ""}`} data-tauri-drag-region>
        {(menuOpen || searchOpen) && (
          <div className="app-title" data-tauri-drag-region>
            <img className="slate-emblem" src="/slate-mark.svg" alt="" />
            <span>Slate</span>
          </div>
        )}
        <nav className="topbar-nav" aria-label="Navegação principal">
          <button
            className={`nav-word ${menuOpen ? "active" : ""}`}
            onClick={() => {
              setMenuOpen((value) => !value);
              setSearchOpen(false);
            }}
          >
            Menu
          </button>
          <button
            className={`nav-word ${searchOpen ? "active" : ""}`}
            onClick={() => {
              setSearchOpen((value) => !value);
              setMenuOpen(false);
            }}
          >
            Buscar
          </button>
        </nav>
        <div className="window-controls" aria-label="Controles da janela">
          <button onClick={() => void getCurrentWindow().minimize()} aria-label="Minimizar janela" title="Minimizar">
            −
          </button>
          <button onClick={() => void getCurrentWindow().toggleMaximize()} aria-label="Maximizar janela" title="Maximizar ou restaurar">
            □
          </button>
          <button className="window-close" onClick={() => void getCurrentWindow().close()} aria-label="Fechar janela" title="Fechar">
            ×
          </button>
        </div>
      </header>

      <div className="tab-strip" role="tablist" aria-label="Anotações abertas">
          {openNotes.map((note) => (
            <div
              className={`note-tab ${activePathKey === note.relativePath ? "active" : ""}`}
              key={note.relativePath}
              onContextMenu={(event) => {
                event.preventDefault();
                openNoteContextMenu(note.relativePath, event.clientX, event.clientY);
              }}
            >
              <button
                className="note-tab-select"
                role="tab"
                aria-selected={activePathKey === note.relativePath}
                onClick={() => void loadNote(note.relativePath)}
                onDoubleClick={() => startRenameNote(note.relativePath)}
                title={displayRelativePath(note.relativePath)}
              >
                {tabLabel(note)}
              </button>
              <button
                className="note-tab-close"
                onClick={() => void closeNoteTab(note.relativePath)}
                aria-label={`Fechar ${tabLabel(note)}`}
                title="Fechar aba; a nota continua salva"
              >
                ×
              </button>
              <button
                className="note-tab-delete"
                onClick={() => setDeleteTargets([note.relativePath])}
                aria-label={`Apagar arquivo ${tabLabel(note)}`}
                title="Apagar arquivo"
              >
                <TrashIcon />
              </button>
            </div>
          ))}
          <button className="new-tab-button" onClick={() => void createDraft()} aria-label="Criar novo rascunho" title="Novo rascunho">
            +
          </button>
      </div>
      <div className="workspace">
        {menuOpen && (
          <aside className="side-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Navegar</p>
                <h2>Pastas e notas</h2>
              </div>
              <button className="icon-button" onClick={() => setMenuOpen(false)} aria-label="Fechar menu">
                ×
              </button>
            </div>
            <div className="folder-create-row">
              <input
                value={newFolderName}
                onChange={(event) => setNewFolderName(event.currentTarget.value)}
                placeholder="Nova pasta"
                aria-label="Nome da nova pasta"
                onKeyDown={(event) => {
                  if (event.key === "Enter") void addFolder();
                }}
              />
              <button className="small-button" onClick={() => void addFolder()} disabled={!newFolderName.trim()}>
                Criar
              </button>
            </div>
            <FolderTree
              entries={entries}
              selectedFolder={selectedFolder}
              onSelectFolder={setSelectedFolder}
              onOpenNote={(path) => void loadNote(path)}
              onRenameNote={startRenameNote}
              onDeleteNote={(path) => setDeleteTargets([path])}
              onNoteContextMenu={openNoteContextMenu}
              selectedNotes={selectedNotePaths}
              onToggleSelection={toggleNoteSelection}
            />
            {selectedNotePaths.size > 0 && (
              <div className="selection-actions">
                <span className="selection-count">
                  {selectedNotePaths.size} {selectedNotePaths.size === 1 ? "nota selecionada" : "notas selecionadas"}
                </span>
                <label className="selection-destination-label" htmlFor="selection-destination">Destino</label>
                <select
                  id="selection-destination"
                  className="folder-select selection-destination"
                  value={selectedFolder}
                  onChange={(event) => setSelectedFolder(event.currentTarget.value)}
                >
                  {folders.map((folder) => (
                    <option value={folder.relativePath} key={folder.relativePath}>
                      {displayRelativePath(folder.relativePath)}
                    </option>
                  ))}
                </select>
                <div className="selection-action-buttons">
                  <button onClick={() => void moveSelectedNotes()} disabled={!canMoveSelected}>Mover</button>
                  <button onClick={() => void copySelectedNotes()}>Copiar</button>
                  <button onClick={() => setDeleteTargets([...selectedNotePaths])}>Apagar</button>
                  <button className="clear-selection-button" onClick={() => setSelectedNotePaths(new Set())}>Limpar</button>
                </div>
              </div>
            )}
            {activeNote && selectedNotePaths.size === 0 && (
              <div className="organize-box">
                <label className="organize-label" htmlFor="organize-target">Mover nota para</label>
                <select
                  id="organize-target"
                  className="folder-select"
                  value={selectedFolder}
                  onChange={(event) => setSelectedFolder(event.currentTarget.value)}
                >
              {folders.map((folder) => (
                    <option value={folder.relativePath} key={folder.relativePath}>
                      {displayRelativePath(folder.relativePath)}
                    </option>
                  ))}
                </select>
                {selectedFolder !== "Draft" && selectedFolder !== activeNote.relativePath.split("/").slice(0, -1).join("/") && (
                  <button className="primary-button" onClick={() => void organizeNote()}>
                    Organizar nota
                  </button>
                )}
              </div>
            )}
            <div className="folder-actions">
              <p className="eyebrow">Pasta de notas</p>
              <button className="folder-action-button" onClick={() => void showNotesFolder()}>
                Abrir no Explorador
              </button>
              <button className="folder-action-button" onClick={() => void chooseVault()}>
                Trocar pasta
              </button>
            </div>
          </aside>
        )}

        {searchOpen && (
          <aside className={`side-panel search-panel ${searchMode === "tree" ? "graph-search-panel" : ""}`}>
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Encontrar</p>
                <h2>Buscar</h2>
              </div>
              <button className="icon-button" onClick={() => setSearchOpen(false)} aria-label="Fechar busca">
                ×
              </button>
            </div>
            <input
              className="search-input"
              autoFocus
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              placeholder="Buscar notas..."
            />
            <div className="search-mode-switch" role="tablist" aria-label="Modo de visualização">
              <button
                className={`search-mode-button ${searchMode === "results" ? "active" : ""}`}
                role="tab"
                aria-selected={searchMode === "results"}
                onClick={() => setSearchMode("results")}
              >
                Resultados
              </button>
              <button
                className={`search-mode-button ${searchMode === "tree" ? "active" : ""}`}
                role="tab"
                aria-selected={searchMode === "tree"}
                onClick={() => setSearchMode("tree")}
              >
                Árvore
              </button>
            </div>
            {searchMode === "results" ? (
              <div className="search-results">
                {searchBusy && <p className="muted-copy">Buscando...</p>}
                {!searchBusy && searchQuery.trim() && searchHits.length === 0 && (
                  <p className="muted-copy">Nenhuma nota encontrada.</p>
                )}
                {searchHits.map((hit) => (
                  <button className="search-hit" key={hit.relativePath} onClick={() => void loadNote(hit.relativePath)}>
                    <span className="search-hit-title">{displayNoteName(hit.name)}</span>
                    <span className="search-hit-path">{displayRelativePath(hit.relativePath)}</span>
                    <span className="search-hit-excerpt">{hit.excerpt}</span>
                  </button>
                ))}
              </div>
            ) : (
              <GraphView
                data={graphData}
                highlightedPaths={new Set(searchHits.map((hit) => hit.relativePath))}
                onOpenNote={(path) => void loadNote(path)}
              />
            )}
          </aside>
        )}

        <section className="note-stage">
          {activeNote ? (
            <>
              <NoteEditor
                pathKey={activeNote.relativePath}
                markdown={activeNote.content}
                notes={noteEntries}
                onOpenNoteLink={(target) => {
                  const targetNote = resolveNoteEntry(target, noteEntries);
                  if (targetNote) void loadNote(targetNote.relativePath);
                  else setError(`A nota vinculada não foi encontrada: ${target}`);
                }}
                onSave={(content, path) => void saveMarkdown(path, content)}
                shouldSkipSave={(path) => blockedSavePaths.current.has(path)}
                onDraft={(content) => {
                  currentContent.current = content;
                }}
              />
            </>
          ) : (
            <div className="empty-state">
              {error ? (
                <>
                  <p>Não foi possível abrir seu rascunho.</p>
                  <button className="primary-button" onClick={() => void initializeDefaultVault()}>
                    Tentar novamente
                  </button>
                </>
              ) : (
                <p>{loading ? "Preparando seu rascunho..." : "Abrindo seu rascunho..."}</p>
              )}
            </div>
          )}
          {error && (
            <div className="toast-error" role="alert">
              <span>{error}</span>
              <button className="icon-button" onClick={() => setError("")} aria-label="Fechar erro">×</button>
            </div>
          )}
        </section>
      </div>
      {noteContextMenu && (
        <div
          className="note-context-menu"
          role="menu"
          style={{ left: noteContextMenu.x, top: noteContextMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
        >
          <button role="menuitem" onClick={() => startRenameNote(noteContextMenu.path)}>
            <span className="rename-menu-icon" aria-hidden="true">✎</span>
            Renomear
          </button>
          <button
            role="menuitem"
            onClick={() => {
              const paths = selectedNotePaths.has(noteContextMenu.path) && selectedNotePaths.size > 1
                ? [...selectedNotePaths]
                : [noteContextMenu.path];
              setDeleteTargets(paths);
              setNoteContextMenu(null);
            }}
          >
            <TrashIcon />
            {selectedNotePaths.has(noteContextMenu.path) && selectedNotePaths.size > 1
              ? `Apagar ${selectedNotePaths.size} arquivos selecionados`
              : "Apagar arquivo"}
          </button>
        </div>
      )}
      {renameTarget && (
        <div
          className="rename-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !renamingNote) setRenameTarget(null);
          }}
        >
          <section className="rename-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-title">
            <h2 id="rename-title">Renomear nota</h2>
            <p>O arquivo será renomeado na pasta atual.</p>
            <input
              autoFocus
              value={renameName}
              onChange={(event) => setRenameName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void confirmRenameNote();
                if (event.key === "Escape" && !renamingNote) setRenameTarget(null);
              }}
              aria-label="Novo nome da nota"
              placeholder="Nome da nota"
              disabled={renamingNote}
            />
            <div className="rename-dialog-actions">
              <button className="cancel-button" onClick={() => setRenameTarget(null)} disabled={renamingNote}>
                Cancelar
              </button>
              <button className="primary-button" onClick={() => void confirmRenameNote()} disabled={renamingNote || !renameName.trim()}>
                {renamingNote ? "Renomeando…" : "Renomear"}
              </button>
            </div>
          </section>
        </div>
      )}
      {deleteTargets.length > 0 && (
        <div
          className="delete-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !deletingNote) setDeleteTargets([]);
          }}
        >
          <section className="delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-title">
            <h2 id="delete-title">
              {deleteTargets.length === 1 ? "Apagar arquivo?" : `Apagar ${deleteTargets.length} arquivos?`}
            </h2>
            {deleteTargets.length === 1 ? (
              <p><strong>{deleteTargetNames[0]}</strong> será apagado da pasta de notas. Esta ação não pode ser desfeita.</p>
            ) : (
              <>
                <p>Estes arquivos serão apagados da pasta de notas. Esta ação não pode ser desfeita.</p>
                <ul className="delete-target-list">
                  {deleteTargetNames.slice(0, 8).map((name, index) => <li key={deleteTargets[index]}>{name}</li>)}
                  {deleteTargetNames.length > 8 && <li>e mais {deleteTargetNames.length - 8}</li>}
                </ul>
              </>
            )}
            <div className="delete-dialog-actions">
              <button className="cancel-button" onClick={() => setDeleteTargets([])} disabled={deletingNote}>
                Cancelar
              </button>
              <button className="delete-confirm-button" onClick={() => void confirmDeleteNote()} disabled={deletingNote}>
                {deletingNote ? "Apagando…" : deleteTargets.length === 1 ? "Apagar arquivo" : `Apagar ${deleteTargets.length} arquivos`}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
