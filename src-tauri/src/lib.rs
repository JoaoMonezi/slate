use serde::Serialize;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Component, Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

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

fn canonical_vault(vault_path: &str) -> Result<PathBuf, String> {
    let root = PathBuf::from(vault_path)
        .canonicalize()
        .map_err(|error| format!("Não foi possível abrir o vault: {error}"))?;
    if !root.is_dir() {
        return Err("O caminho escolhido não é uma pasta.".to_string());
    }
    Ok(root)
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
        return Err("A nota precisa ser um arquivo dentro do vault.".to_string());
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
        return Err("A pasta precisa estar dentro do vault.".to_string());
    }
    Ok(path)
}

fn relative_string(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "O arquivo está fora do vault.".to_string())?;
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
        return Err("A árvore do vault excede o limite de profundidade do protótipo.".to_string());
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
        right
            .is_dir
            .cmp(&left.is_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
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

#[tauri::command]
fn create_draft(vault_path: String) -> Result<NoteData, String> {
    let root = canonical_vault(&vault_path)?;
    let draft_dir = root.join("Draft");
    fs::create_dir_all(&draft_dir)
        .map_err(|error| format!("Não foi possível criar Draft: {error}"))?;
    let draft_dir = draft_dir
        .canonicalize()
        .map_err(|error| format!("Não foi possível abrir Draft: {error}"))?;
    if !draft_dir.starts_with(&root) {
        return Err("A pasta Draft precisa permanecer dentro do vault.".to_string());
    }

    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("Não foi possível obter o horário atual: {error}"))?
        .as_millis();
    for suffix in 0..1000_u32 {
        let name = if suffix == 0 {
            format!("Draft-{timestamp}.md")
        } else {
            format!("Draft-{timestamp}-{suffix}.md")
        };
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
            Err(error) => return Err(format!("Não foi possível criar o Draft: {error}")),
        }
    }
    Err("Não foi possível gerar um nome exclusivo para o Draft.".to_string())
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            create_draft,
            list_vault,
            read_note,
            save_note,
            create_folder,
            move_note,
            search_notes
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
