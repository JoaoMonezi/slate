# Slate

Slate é um aplicativo desktop de notas local-first para capturar ideias rapidamente. Cada nova nota começa em `Draft` e é salva como Markdown dentro do vault escolhido pelo usuário.

## O problema

Escolher pasta, nome ou tags antes de escrever interrompe a captura. O Slate começa pela escrita e deixa a organização para depois, mantendo os arquivos legíveis fora do aplicativo.

## Direção do MVP

- Plataforma inicial: Windows.
- Interface: ações simples `Draft`, `Menu` e `Search`, com uma árvore visual de pastas e notas.
- Escrita: BlockNote, limitada aos recursos que preservam a conversão de e para Markdown.
- Armazenamento: arquivos `.md` locais dentro de uma pasta escolhida pelo usuário; `Draft` é uma pasta real no vault.
- Organização: mover uma nota no Slate move o arquivo correspondente no disco.
- Busca: pesquisa local no conteúdo Markdown. Indexação SQLite/FTS5 e filtros por metadados fazem parte das próximas etapas.
- Metadados: formato ainda será definido; os valores devem permanecer nos arquivos locais.
- Links: formato legível e compatível com Obsidian, com comportamento independente da pasta.

## Arquitetura

- Tauri v2 fornece a janela desktop e a ponte para comandos locais em Rust.
- React, Vite e TypeScript compõem a interface.
- BlockNote fornece o editor em blocos.
- O frontend solicita operações de arquivo ao backend Rust. O conteúdo das notas permanece em Markdown; o índice de busca será derivado e reconstruível.

## Desenvolvimento no Windows

Instale Node.js, Rust com toolchain MSVC, Visual Studio Build Tools com a carga “Desktop development with C++” e WebView2. Depois, na pasta do projeto:

```powershell
npm install
npm run tauri dev
```

Para gerar os arquivos web:

```powershell
npm run build
```

## Estado atual

O protótipo inicial inclui a seleção do vault, criação e salvamento de Drafts Markdown, árvore de arquivos, criação de pastas, movimentação de notas e busca textual. O formato dos metadados, a indexação FTS5 e o suporte completo a links continuam em desenvolvimento.
