import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { BlockNoteView } from "@blocknote/mantine";
import { useCreateBlockNote, useEditorChange } from "@blocknote/react";
import type { VaultEntry, SearchHit, ActiveNote } from "./types";
import "@blocknote/core/fonts/inter.css";
import "@blocknote/mantine/style.css";
import "./App.css";

const VAULT_STORAGE_KEY = "slate.vaultPath";

function NoteEditor({
  pathKey,
  markdown,
  onSave,
  onDraft,
}: {
  pathKey: string;
  markdown: string;
  onSave: (value: string) => void;
  onDraft: (value: string) => void;
}) {
  const editor = useCreateBlockNote();
  const hydrated = useRef(false);
  const pendingMarkdown = useRef(markdown);
  const timer = useRef<number | undefined>(undefined);
  const saveRef = useRef(onSave);
  const draftRef = useRef(onDraft);
  saveRef.current = onSave;
  draftRef.current = onDraft;

  useEffect(() => {
    hydrated.current = false;
    const blocks = editor.tryParseMarkdownToBlocks(markdown);
    editor.replaceBlocks(editor.document, blocks);
    pendingMarkdown.current = markdown;
    hydrated.current = true;
  }, [editor, markdown, pathKey]);

  useEditorChange(() => {
    if (!hydrated.current) return;

    pendingMarkdown.current = editor.blocksToMarkdownLossy();
    draftRef.current(pendingMarkdown.current);
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      saveRef.current(pendingMarkdown.current);
    }, 350);
  }, editor);

  useEffect(
    () => () => {
      if (timer.current !== undefined) window.clearTimeout(timer.current);
      if (hydrated.current) saveRef.current(pendingMarkdown.current);
    },
    [],
  );

  return (
    <div className="editor-shell">
      <BlockNoteView editor={editor} theme="light" />
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

function FolderTree({
  entries,
  selectedFolder,
  onSelectFolder,
  onOpenNote,
}: {
  entries: VaultEntry[];
  selectedFolder: string;
  onSelectFolder: (path: string) => void;
  onOpenNote: (path: string) => void;
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
                title={`Escolher ${node.name} como destino da nota`}
              >
                <span className="tree-icon">▱</span>
                <span>{node.name}</span>
              </button>
            </div>
            {isExpanded && node.children.length > 0 && (
              <div>{renderEntries(node.children, depth + 1)}</div>
            )}
          </div>
        );
      }

      return (
        <button
          className="tree-row file-row"
          key={node.relativePath}
          style={{ paddingLeft: `${28 + depth * 16}px` }}
          onClick={() => onOpenNote(node.relativePath)}
          title={node.relativePath}
        >
          <span className="tree-icon file-icon">·</span>
          <span className="tree-label">{node.name}</span>
        </button>
      );
    });

  return <div className="tree-list">{renderEntries(entries)}</div>;
}

function App() {
  const [vaultPath, setVaultPath] = useState(() => localStorage.getItem(VAULT_STORAGE_KEY) ?? "");
  const [activeNote, setActiveNote] = useState<ActiveNote | null>(null);
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [searchHits, setSearchHits] = useState<SearchHit[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchBusy, setSearchBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedFolder, setSelectedFolder] = useState("Draft");
  const [newFolderName, setNewFolderName] = useState("");
  const [saveState, setSaveState] = useState<"saved" | "saving" | "error">("saved");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const startupVault = useRef("");
  const activePath = useRef("");
  const currentContent = useRef("");
  const saveQueue = useRef<Promise<void>>(Promise.resolve());

  activePath.current = activeNote?.relativePath ?? "";

  const refreshTree = useCallback(async (path: string) => {
    const nextEntries = await invoke<VaultEntry[]>("list_vault", { vaultPath: path });
    setEntries(nextEntries);
    return nextEntries;
  }, []);

  const persistNote = useCallback((path: string, relativePath: string, content: string) => {
    const pending = saveQueue.current
      .catch(() => undefined)
      .then(() => invoke<void>("save_note", { vaultPath: path, relativePath, content }));
    saveQueue.current = pending;
    return pending;
  }, []);

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
        setActiveNote(note);
        activePath.current = note.relativePath;
        currentContent.current = note.content;
        setSaveState("saved");
        setMenuOpen(false);
        setSearchOpen(false);
      } catch (cause) {
        setError(String(cause));
      } finally {
        setLoading(false);
      }
    },
    [persistNote, vaultPath],
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
        setActiveNote(note);
        activePath.current = note.relativePath;
        currentContent.current = note.content;
        setSaveState("saved");
        setMenuOpen(false);
        setSearchOpen(false);
      } catch (cause) {
        setError(String(cause));
      } finally {
        setLoading(false);
      }
    },
    [persistNote, refreshTree, vaultPath],
  );

  useEffect(() => {
    if (!vaultPath || startupVault.current === vaultPath) return;
    startupVault.current = vaultPath;
    void (async () => {
      try {
        await refreshTree(vaultPath);
        await createDraft(vaultPath);
      } catch (cause) {
        setError(String(cause));
        setVaultPath("");
        localStorage.removeItem(VAULT_STORAGE_KEY);
      }
    })();
  }, [createDraft, refreshTree, vaultPath]);

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

  async function chooseVault() {
    if (activePath.current && vaultPath) {
      await persistNote(vaultPath, activePath.current, currentContent.current).catch(() => undefined);
    }
    const selected = await open({ directory: true, multiple: false, title: "Escolher vault do Slate" });
    if (typeof selected !== "string") return;
    localStorage.setItem(VAULT_STORAGE_KEY, selected);
    startupVault.current = "";
    setVaultPath(selected);
    setActiveNote(null);
    activePath.current = "";
    currentContent.current = "";
    setError("");
  }

  async function saveMarkdown(relativePath: string, content: string) {
    if (!vaultPath || !relativePath) return;
    if (activePath.current === relativePath) currentContent.current = content;
    setSaveState("saving");
    try {
      await persistNote(vaultPath, relativePath, content);
      if (activePath.current === relativePath) setSaveState("saved");
    } catch (cause) {
      if (activePath.current === relativePath) {
        setSaveState("error");
        setError(String(cause));
      }
    }
  }

  async function organizeNote() {
    if (!activeNote || !selectedFolder || selectedFolder === "Draft") return;
    setError("");
    try {
      await persistNote(vaultPath, activeNote.relativePath, currentContent.current);
      const moved = await invoke<ActiveNote>("move_note", {
        vaultPath,
        sourceRelativePath: activeNote.relativePath,
        destinationRelativePath: selectedFolder,
      });
      await refreshTree(vaultPath);
      setActiveNote(moved);
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

  if (!vaultPath) {
    return (
      <main className="setup-screen">
        <section className="setup-card">
          <p className="eyebrow">Slate</p>
          <h1>Escolha seu vault</h1>
          <p className="setup-copy">As notas ficam em arquivos Markdown dentro de uma pasta sua.</p>
          <button className="primary-button" onClick={() => void chooseVault()}>
            Escolher pasta
          </button>
          {error && <p className="error-message">{error}</p>}
        </section>
      </main>
    );
  }

  return (
    <main className="slate-app">
      <header className="topbar">
        <div className="brand-mark" aria-label="Slate">S</div>
        <nav className="topbar-nav" aria-label="Navegação principal">
          <button className="nav-word active" onClick={() => void createDraft()} title="Criar um Draft novo">
            Draft
          </button>
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
            Search
          </button>
        </nav>
        <div className="topbar-right">
          <span className={`save-indicator ${saveState}`}>
            {saveState === "saving" ? "Salvando" : saveState === "error" ? "Erro ao salvar" : "Salvo"}
          </span>
          <button className="vault-button" onClick={() => void chooseVault()} title={vaultPath}>
            Trocar vault
          </button>
        </div>
      </header>

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
            />
            {activeNote && (
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
                      {folder.relativePath}
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
          </aside>
        )}

        {searchOpen && (
          <aside className="side-panel search-panel">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Encontrar</p>
                <h2>Search</h2>
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
              placeholder="Pesquisar notas..."
            />
            <div className="search-results">
              {searchBusy && <p className="muted-copy">Buscando...</p>}
              {!searchBusy && searchQuery.trim() && searchHits.length === 0 && (
                <p className="muted-copy">Nenhuma nota encontrada.</p>
              )}
              {searchHits.map((hit) => (
                <button className="search-hit" key={hit.relativePath} onClick={() => void loadNote(hit.relativePath)}>
                  <span className="search-hit-title">{hit.name}</span>
                  <span className="search-hit-path">{hit.relativePath}</span>
                  <span className="search-hit-excerpt">{hit.excerpt}</span>
                </button>
              ))}
            </div>
          </aside>
        )}

        <section className="note-stage">
          {activeNote ? (
            <>
              <div className="note-context">
                <span className="note-location">{activeNote.relativePath}</span>
                <span className="note-dot">·</span>
                <span>{loading ? "Abrindo" : "Markdown local"}</span>
              </div>
              <NoteEditor
                pathKey={activeNote.relativePath}
                markdown={activeNote.content}
                onSave={(content) => void saveMarkdown(activeNote.relativePath, content)}
                onDraft={(content) => {
                  currentContent.current = content;
                }}
              />
            </>
          ) : (
            <div className="empty-state">
              <span className="empty-mark">S</span>
              <p>Preparando seu Draft...</p>
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
    </main>
  );
}

export default App;
