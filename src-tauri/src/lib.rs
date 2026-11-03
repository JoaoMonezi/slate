use serde::Serialize;
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
};
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VaultEntry {
    name: String,
    relative_path: String,
    is_dir: bool,
    children: Vec<VaultEntry>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteData {
    name: String,
    relative_path: String,
    content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SearchHit {
    name: String,
    relative_path: String,
    excerpt: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphNode {
    id: String,
    label: String,
    relative_path: String,
    kind: String,
    parent_id: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphEdge {
    source: String,
    target: String,
    kind: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GraphData {
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
}

struct GraphNote {
    id: String,
    relative_path: String,
    content: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MovedNote {
    source_relative_path: String,
    note: NoteData,
}

fn canonical_vault(vault_path: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(vault_path)
        .canonicalize()
        .map_err(|error| format!("Não foi possível abrir a pasta de notas: {error}"))?;
    if !root.is_dir() {
        return Err("O caminho escolhido não é uma pasta.".to_string());
    }
    Ok(root)
}

#[tauri::command]
fn ensure_default_vault(app: AppHandle) -> Result<String, String> {
    let documents = app
        .path()
        .document_dir()
        .map_err(|error| format!("Não foi possível localizar Documentos: {error}"))?;
    let vault = documents.join("Slate");
    fs::create_dir_all(&vault)
        .map_err(|error| format!("Não foi possível criar a pasta padrão: {error}"))?;
    vault
        .canonicalize()
        .map(|path| path.to_string_lossy().to_string())
        .map_err(|error| format!("Não foi possível abrir a pasta padrão: {error}"))
}

fn validate_relative_path(relative_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(relative_path);
    if path.is_absolute()
        || path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("Caminho de nota inválido.".to_string());
    }
    Ok(path.to_path_buf())
}

fn resolve_note(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = validate_relative_path(relative_path)?;
    let path = root
        .join(relative)
        .canonicalize()
        .map_err(|error| format!("Não foi possível acessar a nota: {error}"))?;
    if !path.starts_with(root) || !path.is_file() {
        return Err("A nota precisa ser um arquivo dentro da pasta de notas.".to_string());
    }
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
    {
        return Err("O Slate só abre arquivos Markdown (.md).".to_string());
    }
    Ok(path)
}

fn resolve_note_to_delete(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    let relative = validate_relative_path(relative_path)?;
    let path = root.join(relative);
    let metadata = fs::symlink_metadata(&path)
        .map_err(|error| format!("Não foi possível acessar a nota: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("Só é possível apagar arquivos de nota dentro da pasta de notas.".to_string());
    }
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
    {
        return Err("Só é possível apagar arquivos Markdown.".to_string());
    }
    let parent = path
        .parent()
        .ok_or_else(|| "Não foi possível localizar a pasta da nota.".to_string())?
        .canonicalize()
        .map_err(|error| format!("Não foi possível acessar a pasta da nota: {error}"))?;
    if !parent.starts_with(root) {
        return Err("A nota precisa permanecer dentro da pasta de notas.".to_string());
    }
    Ok(path)
}

fn resolve_directory(root: &Path, relative_path: &str) -> Result<PathBuf, String> {
    if relative_path.is_empty() {
        return Ok(root.to_path_buf());
    }
    let relative = validate_relative_path(relative_path)?;
    let path = root
        .join(relative)
        .canonicalize()
        .map_err(|error| format!("Não foi possível acessar a pasta: {error}"))?;
    if !path.starts_with(root) || !path.is_dir() {
        return Err("A pasta precisa estar dentro da pasta de notas.".to_string());
    }
    Ok(path)
}

fn relative_string(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "O arquivo está fora da pasta de notas.".to_string())?;
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

fn skipped_directory(name: &str) -> bool {
    matches!(
        name.to_ascii_lowercase().as_str(),
        ".git" | ".obsidian" | "node_modules" | "target" | ".trash"
    ) || name.starts_with('.')
}

fn read_tree(root: &Path, current: &Path, depth: usize) -> Result<Vec<VaultEntry>, String> {
    if depth > 32 {
        return Err("A árvore de pastas excede o limite de profundidade do protótipo.".to_string());
    }

    let mut entries = Vec::new();
    for item in fs::read_dir(current)
        .map_err(|error| format!("Não foi possível listar a pasta: {error}"))?
    {
        let item =
            item.map_err(|error| format!("Não foi possível ler uma entrada da pasta: {error}"))?;
        let file_type = item
            .file_type()
            .map_err(|error| format!("Não foi possível verificar uma entrada: {error}"))?;
        if file_type.is_symlink() {
            continue;
        }

        let path = item.path();
        let name = item.file_name().to_string_lossy().to_string();
        if file_type.is_dir() {
            if skipped_directory(&name) {
                continue;
            }
            entries.push(VaultEntry {
                name,
                relative_path: relative_string(root, &path)?,
                is_dir: true,
                children: read_tree(root, &path, depth + 1)?,
            });
        } else if file_type.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
        {
            entries.push(VaultEntry {
                name,
                relative_path: relative_string(root, &path)?,
                is_dir: false,
                children: Vec::new(),
            });
        }
    }

    entries.sort_by(|left, right| {
        let names_order = match (numbered_draft(&left.name), numbered_draft(&right.name)) {
            (Some(left_number), Some(right_number)) => left_number.cmp(&right_number),
            _ => left.name.to_lowercase().cmp(&right.name.to_lowercase()),
        };
        right.is_dir.cmp(&left.is_dir).then(names_order)
    });
    Ok(entries)
}

fn collect_search_hits(
    root: &Path,
    current: &Path,
    query: &str,
    hits: &mut Vec<SearchHit>,
    depth: usize,
) -> Result<(), String> {
    if depth > 32 || hits.len() >= 100 {
        return Ok(());
    }
    for item in fs::read_dir(current)
        .map_err(|error| format!("Não foi possível pesquisar a pasta: {error}"))?
    {
        let item =
            item.map_err(|error| format!("Não foi possível ler uma entrada da pasta: {error}"))?;
        let file_type = item
            .file_type()
            .map_err(|error| format!("Não foi possível verificar uma entrada: {error}"))?;
        if file_type.is_symlink() {
            continue;
        }
        let path = item.path();
        let name = item.file_name().to_string_lossy().to_string();
        if file_type.is_dir() {
            if !skipped_directory(&name) {
                collect_search_hits(root, &path, query, hits, depth + 1)?;
            }
        } else if file_type.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
        {
            let content = match fs::read_to_string(&path) {
                Ok(content) => content,
                Err(_) => continue,
            };
            if content.to_lowercase().contains(query) || name.to_lowercase().contains(query) {
                let excerpt = content
                    .lines()
                    .find(|line| line.to_lowercase().contains(query))
                    .unwrap_or(content.lines().next().unwrap_or(""))
                    .trim()
                    .chars()
                    .take(180)
                    .collect::<String>();
                hits.push(SearchHit {
                    name,
                    relative_path: relative_string(root, &path)?,
                    excerpt,
                });
                if hits.len() >= 100 {
                    return Ok(());
                }
            }
        }
    }
    Ok(())
}

fn collect_graph_nodes(
    root: &Path,
    current: &Path,
    parent_id: &str,
    nodes: &mut Vec<GraphNode>,
    notes: &mut Vec<GraphNote>,
    depth: usize,
) -> Result<(), String> {
    if depth > 32 {
        return Ok(());
    }
    for item in fs::read_dir(current)
        .map_err(|error| format!("Não foi possível listar a pasta: {error}"))?
    {
        let item = item.map_err(|error| format!("Não foi possível ler uma entrada: {error}"))?;
        let file_type = item
            .file_type()
            .map_err(|error| format!("Não foi possível verificar uma entrada: {error}"))?;
        if file_type.is_symlink() {
            continue;
        }
        let path = item.path();
        let name = item.file_name().to_string_lossy().to_string();
        if file_type.is_dir() {
            if skipped_directory(&name) {
                continue;
            }
            let relative_path = relative_string(root, &path)?;
            let id = format!("folder:{relative_path}");
            nodes.push(GraphNode {
                id: id.clone(),
                label: name,
                relative_path,
                kind: "folder".to_string(),
                parent_id: Some(parent_id.to_string()),
            });
            collect_graph_nodes(root, &path, &id, nodes, notes, depth + 1)?;
        } else if file_type.is_file()
            && path
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
        {
            let relative_path = relative_string(root, &path)?;
            let id = format!("note:{relative_path}");
            nodes.push(GraphNode {
                id: id.clone(),
                label: name,
                relative_path: relative_path.clone(),
                kind: "note".to_string(),
                parent_id: Some(parent_id.to_string()),
            });
            if let Ok(content) = fs::read_to_string(&path) {
                notes.push(GraphNote {
                    id,
                    relative_path,
                    content,
                });
            }
        }
    }
    Ok(())
}

fn wiki_link_targets(content: &str) -> Vec<String> {
    let mut targets = Vec::new();
    let mut remaining = content;
    while let Some(start) = remaining.find("[[") {
        let after_open = &remaining[start + 2..];
        let Some(end) = after_open.find("]]") else {
            break;
        };
        let target = after_open[..end]
            .split('|')
            .next()
            .unwrap_or("")
            .split('#')
            .next()
            .unwrap_or("")
            .trim();
        if !target.is_empty() {
            targets.push(target.to_string());
        }
        remaining = &after_open[end + 2..];
    }
    targets
}

fn encode_note_target(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

fn replace_wiki_link_target(content: &str, old_target: &str, new_target: &str) -> String {
    let old_target = normalized_note_target(old_target);
    let mut output = String::with_capacity(content.len());
    let mut remaining = content;
    while let Some(start) = remaining.find("[[") {
        output.push_str(&remaining[..start]);
        let after_open = &remaining[start + 2..];
        let Some(end) = after_open.find("]]") else {
            output.push_str(&remaining[start..]);
            return output;
        };
        let link_body = &after_open[..end];
        let target_end = link_body.find(['|', '#']).unwrap_or(link_body.len());
        if normalized_note_target(link_body[..target_end].trim()) == old_target {
            output.push_str("[[");
            output.push_str(new_target);
            output.push_str(&link_body[target_end..]);
            output.push_str("]]");
        } else {
            output.push_str("[[");
            output.push_str(link_body);
            output.push_str("]]");
        }
        remaining = &after_open[end + 2..];
    }
    output.push_str(remaining);
    output
}

fn update_note_link_targets(content: &str, old_target: &str, new_target: &str) -> String {
    let content = replace_wiki_link_target(content, old_target, new_target);
    let old_encoded = encode_note_target(old_target);
    let new_encoded = encode_note_target(new_target);
    content
        .replace(
            &format!("#slate-note/{old_encoded}"),
            &format!("#slate-note/{new_encoded}"),
        )
        .replace(
            &format!("slate-note://note/{old_encoded}"),
            &format!("#slate-note/{new_encoded}"),
        )
}

fn decode_percent_encoded(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                decoded.push(byte);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn markdown_note_link_targets(content: &str) -> Vec<String> {
    const NOTE_LINK_PREFIX: &str = "slate-note://note/";
    const LOCAL_NOTE_LINK_PREFIX: &str = "#slate-note/";
    let mut targets = Vec::new();
    let mut remaining = content;
    while let Some(start) = remaining.find("](") {
        let after_open = &remaining[start + 2..];
        let Some(end) = after_open.find(')') else {
            break;
        };
        let destination = after_open[..end].trim();
        if let Some(target) = destination
            .strip_prefix(LOCAL_NOTE_LINK_PREFIX)
            .or_else(|| destination.strip_prefix(NOTE_LINK_PREFIX))
        {
            let target = decode_percent_encoded(target);
            if !target.trim().is_empty() {
                targets.push(target);
            }
        }
        remaining = &after_open[end + 1..];
    }
    targets
}

fn normalized_note_target(value: &str) -> String {
    let normalized = value
        .replace('\\', "/")
        .trim_start_matches("./")
        .trim_start_matches('/')
        .to_lowercase();
    normalized
        .strip_suffix(".md")
        .unwrap_or(&normalized)
        .to_string()
}

fn resolve_graph_link(target: &str, notes: &[GraphNote]) -> Option<String> {
    let target = normalized_note_target(target);
    let exact = notes
        .iter()
        .find(|note| normalized_note_target(&note.relative_path) == target);
    if let Some(note) = exact {
        return Some(note.id.clone());
    }
    let path_match = notes.iter().find(|note| {
        normalized_note_target(&note.relative_path)
            .strip_suffix(&target)
            .is_some_and(|prefix| prefix.ends_with('/'))
    });
    if let Some(note) = path_match {
        return Some(note.id.clone());
    }
    let mut basename_matches = notes.iter().filter(|note| {
        Path::new(&note.relative_path)
            .file_stem()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.eq_ignore_ascii_case(&target))
    });
    let first = basename_matches.next()?;
    basename_matches.next().is_none().then(|| first.id.clone())
}

#[tauri::command]
fn get_graph_data(vault_path: String) -> Result<GraphData, String> {
    let root = canonical_vault(&vault_path)?;
    let root_label = root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Notas")
        .to_string();
    let root_id = "folder:".to_string();
    let mut nodes = vec![GraphNode {
        id: root_id.clone(),
        label: root_label,
        relative_path: String::new(),
        kind: "folder".to_string(),
        parent_id: None,
    }];
    let mut notes = Vec::new();
    collect_graph_nodes(&root, &root, &root_id, &mut nodes, &mut notes, 0)?;
    let mut unique_edges = HashSet::new();
    let mut edges = Vec::new();
    for note in &notes {
        let mut targets = wiki_link_targets(&note.content);
        targets.extend(markdown_note_link_targets(&note.content));
        for target in targets {
            if let Some(target_id) = resolve_graph_link(&target, &notes) {
                if unique_edges.insert((note.id.clone(), target_id.clone())) {
                    edges.push(GraphEdge {
                        source: note.id.clone(),
                        target: target_id,
                        kind: "link".to_string(),
                    });
                }
            }
        }
    }
    Ok(GraphData { nodes, edges })
}

fn numbered_draft(name: &str) -> Option<u64> {
    Path::new(name)
        .file_stem()?
        .to_str()?
        .strip_prefix("Rascunho ")?
        .parse()
        .ok()
}

#[tauri::command]
fn create_draft(vault_path: String) -> Result<NoteData, String> {
    let root = canonical_vault(&vault_path)?;
    let draft_dir = root.join("Draft");
    fs::create_dir_all(&draft_dir)
        .map_err(|error| format!("Não foi possível criar a pasta de rascunhos: {error}"))?;
    let draft_dir = draft_dir
        .canonicalize()
        .map_err(|error| format!("Não foi possível abrir a pasta de rascunhos: {error}"))?;
    if !draft_dir.starts_with(&root) {
        return Err(
            "A pasta de rascunhos precisa permanecer dentro da pasta de notas.".to_string(),
        );
    }

    let mut next_number = 1_u64;
    for item in fs::read_dir(&draft_dir)
        .map_err(|error| format!("Não foi possível listar os rascunhos: {error}"))?
    {
        let item = item.map_err(|error| format!("Não foi possível ler um rascunho: {error}"))?;
        if item
            .file_type()
            .map_err(|error| format!("Não foi possível verificar um rascunho: {error}"))?
            .is_file()
            && item
                .path()
                .extension()
                .and_then(|extension| extension.to_str())
                .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
        {
            let filename = item.file_name();
            if let Some(number) = numbered_draft(&filename.to_string_lossy()) {
                next_number = next_number.max(number.saturating_add(1));
            }
        }
    }
    for offset in 0..1000_u64 {
        let number = next_number.saturating_add(offset);
        let name = format!("Rascunho {number}.md");
        let path = draft_dir.join(&name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(_) => {
                return Ok(NoteData {
                    name,
                    relative_path: relative_string(&root, &path)?,
                    content: String::new(),
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Não foi possível criar o rascunho: {error}")),
        }
    }
    Err("Não foi possível gerar um nome exclusivo para o rascunho.".to_string())
}

#[tauri::command]
fn list_vault(vault_path: String) -> Result<Vec<VaultEntry>, String> {
    let root = canonical_vault(&vault_path)?;
    read_tree(&root, &root, 0)
}

#[tauri::command]
fn read_note(vault_path: String, relative_path: String) -> Result<NoteData, String> {
    let root = canonical_vault(&vault_path)?;
    let path = resolve_note(&root, &relative_path)?;
    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Não foi possível ler a nota: {error}"))?;
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Nota.md")
        .to_string();
    Ok(NoteData {
        name,
        relative_path: relative_string(&root, &path)?,
        content,
    })
}

#[tauri::command]
fn rename_note(
    vault_path: String,
    relative_path: String,
    new_name: String,
) -> Result<NoteData, String> {
    let new_name = new_name.trim();
    let new_stem = new_name
        .strip_suffix(".md")
        .or_else(|| new_name.strip_suffix(".MD"))
        .unwrap_or(new_name)
        .trim();
    if new_stem.is_empty()
        || new_stem == "."
        || new_stem == ".."
        || new_stem.ends_with(['.', ' '])
        || new_stem.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
    {
        return Err(
            "Use um nome de arquivo válido, sem barras ou caracteres especiais.".to_string(),
        );
    }

    let root = canonical_vault(&vault_path)?;
    let source = resolve_note(&root, &relative_path)?;
    let parent = source
        .parent()
        .ok_or_else(|| "Não foi possível localizar a pasta da nota.".to_string())?;
    let old_stem = source
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Não foi possível identificar o nome atual da nota.".to_string())?;
    if old_stem.eq_ignore_ascii_case(new_stem) {
        return read_note(vault_path, relative_path);
    }

    let target = parent.join(format!("{new_stem}.md"));
    if target.exists() {
        return Err("Já existe uma nota com esse nome nesta pasta.".to_string());
    }
    let old_relative = relative_string(&root, &source)?;
    let new_relative = relative_string(&root, &target)?;
    let old_relative_target = old_relative
        .strip_suffix(".md")
        .or_else(|| old_relative.strip_suffix(".MD"))
        .unwrap_or(&old_relative);
    let new_relative_target = new_relative
        .strip_suffix(".md")
        .or_else(|| new_relative.strip_suffix(".MD"))
        .unwrap_or(&new_relative);

    let root_id = "folder:".to_string();
    let mut graph_nodes = Vec::new();
    let mut notes = Vec::new();
    collect_graph_nodes(&root, &root, &root_id, &mut graph_nodes, &mut notes, 0)?;
    let old_name_is_duplicate = notes
        .iter()
        .filter(|note| note.relative_path != old_relative)
        .filter(|note| {
            Path::new(&note.relative_path)
                .file_stem()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case(old_stem))
        })
        .count()
        > 0;
    let new_name_is_duplicate = notes
        .iter()
        .filter(|note| note.relative_path != old_relative)
        .filter(|note| {
            Path::new(&note.relative_path)
                .file_stem()
                .and_then(|name| name.to_str())
                .is_some_and(|name| name.eq_ignore_ascii_case(new_stem))
        })
        .count()
        > 0;
    let old_target = if old_name_is_duplicate {
        old_relative_target
    } else {
        old_stem
    };
    let new_target = if new_name_is_duplicate {
        new_relative_target
    } else {
        new_stem
    };

    let mut updates = Vec::new();
    for note in &notes {
        let updated = update_note_link_targets(&note.content, old_target, new_target);
        if updated != note.content {
            let path = if note.relative_path == old_relative {
                target.clone()
            } else {
                root.join(&note.relative_path)
            };
            updates.push((path, note.content.clone(), updated));
        }
    }

    fs::rename(&source, &target)
        .map_err(|error| format!("Não foi possível renomear a nota: {error}"))?;
    let mut written_paths = Vec::new();
    for (path, original, updated) in &updates {
        if let Err(error) = fs::write(path, updated) {
            for (written_path, original_content) in written_paths.into_iter().rev() {
                let _ = fs::write(written_path, original_content);
            }
            let _ = fs::rename(&target, &source);
            return Err(format!(
                "Não foi possível atualizar os links da nota: {error}"
            ));
        }
        written_paths.push((path.clone(), original.clone()));
    }

    read_note(vault_path, new_relative)
}

#[tauri::command]
fn save_note(vault_path: String, relative_path: String, content: String) -> Result<(), String> {
    let root = canonical_vault(&vault_path)?;
    let path = resolve_note(&root, &relative_path)?;
    let parent = path
        .parent()
        .ok_or_else(|| "Não foi possível localizar a pasta da nota.".to_string())?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)
        .map_err(|error| format!("Não foi possível preparar o salvamento: {error}"))?;
    temporary
        .write_all(content.as_bytes())
        .map_err(|error| format!("Não foi possível gravar o conteúdo: {error}"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| format!("Não foi possível confirmar a gravação: {error}"))?;
    temporary.persist(&path).map_err(|error| {
        format!(
            "Não foi possível substituir o arquivo da nota: {}",
            error.error
        )
    })?;
    Ok(())
}

#[tauri::command]
fn delete_note(vault_path: String, relative_path: String) -> Result<(), String> {
    delete_notes(vault_path, vec![relative_path])
}

#[tauri::command]
fn delete_notes(vault_path: String, relative_paths: Vec<String>) -> Result<(), String> {
    let root = canonical_vault(&vault_path)?;
    let mut paths = Vec::with_capacity(relative_paths.len());
    for relative_path in relative_paths {
        let path = resolve_note_to_delete(&root, &relative_path)?;
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    for path in paths {
        fs::remove_file(&path).map_err(|error| {
            format!(
                "Não foi possível apagar {}: {error}",
                relative_string(&root, &path).unwrap_or_default()
            )
        })?;
    }
    Ok(())
}

#[tauri::command]
fn create_folder(
    vault_path: String,
    parent_relative_path: String,
    name: String,
) -> Result<String, String> {
    let name = name.trim();
    if name.is_empty()
        || name == "."
        || name == ".."
        || name
            .chars()
            .any(|character| matches!(character, '/' | '\\' | ':'))
        || name.starts_with('.')
    {
        return Err("Use um nome simples para a pasta, sem barras ou dois-pontos.".to_string());
    }

    let root = canonical_vault(&vault_path)?;
    let parent = resolve_directory(&root, &parent_relative_path)?;
    let new_folder = parent.join(name);
    fs::create_dir(&new_folder).map_err(|error| {
        if error.kind() == std::io::ErrorKind::AlreadyExists {
            "Já existe uma pasta com esse nome nesse local.".to_string()
        } else {
            format!("Não foi possível criar a pasta: {error}")
        }
    })?;
    relative_string(&root, &new_folder)
}

#[tauri::command]
fn move_note(
    vault_path: String,
    source_relative_path: String,
    destination_relative_path: String,
) -> Result<NoteData, String> {
    let root = canonical_vault(&vault_path)?;
    let source = resolve_note(&root, &source_relative_path)?;
    let destination = resolve_directory(&root, &destination_relative_path)?;
    if source.parent() == Some(destination.as_path()) {
        return Err("A nota já está nessa pasta.".to_string());
    }
    let file_name = source
        .file_name()
        .ok_or_else(|| "Não foi possível identificar o arquivo da nota.".to_string())?;
    let target = destination.join(file_name);
    if target.exists() {
        return Err("Já existe uma nota com esse nome na pasta de destino.".to_string());
    }
    fs::rename(&source, &target)
        .map_err(|error| format!("Não foi possível mover a nota: {error}"))?;
    let name = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("Nota.md")
        .to_string();
    let content = fs::read_to_string(&target)
        .map_err(|error| format!("A nota foi movida, mas não pôde ser reaberta: {error}"))?;
    Ok(NoteData {
        name,
        relative_path: relative_string(&root, &target)?,
        content,
    })
}

#[tauri::command]
fn move_notes(
    vault_path: String,
    source_relative_paths: Vec<String>,
    destination_relative_path: String,
) -> Result<Vec<MovedNote>, String> {
    let root = canonical_vault(&vault_path)?;
    let destination = resolve_directory(&root, &destination_relative_path)?;
    let mut plans = Vec::new();
    let mut seen_sources = HashSet::new();
    let mut reserved_targets = HashSet::new();

    for source_relative_path in source_relative_paths {
        let source = resolve_note(&root, &source_relative_path)?;
        if !seen_sources.insert(source.clone()) {
            continue;
        }
        let file_name = source
            .file_name()
            .ok_or_else(|| "Não foi possível identificar o arquivo da nota.".to_string())?;
        let target = destination.join(file_name);
        let is_already_there = source.parent() == Some(destination.as_path());
        if !is_already_there {
            if target.exists() || !reserved_targets.insert(target.clone()) {
                return Err(format!(
                    "Já existe um arquivo chamado {} na pasta de destino.",
                    file_name.to_string_lossy()
                ));
            }
        }
        let content = fs::read_to_string(&source)
            .map_err(|error| format!("Não foi possível ler a nota: {error}"))?;
        plans.push((
            source_relative_path,
            source,
            target,
            is_already_there,
            content,
        ));
    }

    let mut completed = Vec::new();
    for (_, source, target, is_already_there, _) in &plans {
        if *is_already_there {
            continue;
        }
        if let Err(error) = fs::rename(source, target) {
            let mut rollback_errors = Vec::new();
            for (original, moved) in completed.iter().rev() {
                if let Err(rollback_error) = fs::rename(moved, original) {
                    rollback_errors.push(rollback_error.to_string());
                }
            }
            let detail = if rollback_errors.is_empty() {
                String::new()
            } else {
                format!(
                    " A restauração de alguns arquivos também falhou: {}",
                    rollback_errors.join("; ")
                )
            };
            return Err(format!("Não foi possível mover a nota: {error}.{detail}"));
        }
        completed.push((source.clone(), target.clone()));
    }

    plans
        .into_iter()
        .map(
            |(source_relative_path, source, target, is_already_there, content)| {
                let final_path = if is_already_there { source } else { target };
                let name = final_path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("Nota.md")
                    .to_string();
                Ok(MovedNote {
                    source_relative_path,
                    note: NoteData {
                        name,
                        relative_path: relative_string(&root, &final_path)?,
                        content,
                    },
                })
            },
        )
        .collect()
}

fn copy_target_path(
    destination: &Path,
    source: &Path,
    reserved: &mut HashSet<String>,
) -> Result<PathBuf, String> {
    let original_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Não foi possível identificar o nome do arquivo.".to_string())?;
    let stem = source
        .file_stem()
        .and_then(|name| name.to_str())
        .ok_or_else(|| "Não foi possível identificar o nome da nota.".to_string())?;
    let extension = source
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("md");
    let direct = destination.join(original_name);
    let direct_key = direct.to_string_lossy().to_lowercase();
    if !direct.exists() && reserved.insert(direct_key) {
        return Ok(direct);
    }

    for suffix in 1..=1000_u32 {
        let copy_suffix = if suffix == 1 {
            " - cópia".to_string()
        } else {
            format!(" - cópia {suffix}")
        };
        let candidate = destination.join(format!("{stem}{copy_suffix}.{extension}"));
        let key = candidate.to_string_lossy().to_lowercase();
        if !candidate.exists() && reserved.insert(key) {
            return Ok(candidate);
        }
    }
    Err("Não foi possível gerar um nome exclusivo para a cópia.".to_string())
}

#[tauri::command]
fn copy_notes(
    vault_path: String,
    source_relative_paths: Vec<String>,
    destination_relative_path: String,
) -> Result<(), String> {
    let root = canonical_vault(&vault_path)?;
    let destination = resolve_directory(&root, &destination_relative_path)?;
    let mut sources = Vec::new();
    let mut seen_sources = HashSet::new();
    for relative_path in source_relative_paths {
        let source = resolve_note(&root, &relative_path)?;
        if seen_sources.insert(source.clone()) {
            sources.push(source);
        }
    }

    let mut reserved_targets = HashSet::new();
    let mut plans = Vec::new();
    for source in sources {
        let target = copy_target_path(&destination, &source, &mut reserved_targets)?;
        plans.push((source, target));
    }

    let mut created = Vec::new();
    for (source, target) in plans {
        let copy_result = (|| -> Result<(), String> {
            let mut input = fs::File::open(&source)
                .map_err(|error| format!("Não foi possível ler a nota: {error}"))?;
            let mut output = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&target)
                .map_err(|error| format!("Não foi possível criar a cópia: {error}"))?;
            std::io::copy(&mut input, &mut output)
                .map_err(|error| format!("Não foi possível copiar a nota: {error}"))?;
            output
                .sync_all()
                .map_err(|error| format!("Não foi possível confirmar a cópia: {error}"))?;
            Ok(())
        })();

        if let Err(error) = copy_result {
            let _ = fs::remove_file(&target);
            for path in created.iter().rev() {
                let _ = fs::remove_file(path);
            }
            return Err(error);
        }
        created.push(target);
    }
    Ok(())
}

#[tauri::command]
fn search_notes(vault_path: String, query: String) -> Result<Vec<SearchHit>, String> {
    let root = canonical_vault(&vault_path)?;
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let mut hits = Vec::new();
    collect_search_hits(&root, &root, &query, &mut hits, 0)?;
    Ok(hits)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Debug)
                .max_file_size(5_000_000)
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|_| {
            log::info!("Slate started");
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ensure_default_vault,
            create_draft,
            list_vault,
            read_note,
            rename_note,
            save_note,
            delete_note,
            delete_notes,
            create_folder,
            move_note,
            move_notes,
            copy_notes,
            search_notes,
            get_graph_data
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
