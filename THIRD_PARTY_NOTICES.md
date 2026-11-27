# Third-Party Notices & Acknowledgments

Klanker is licensed under the MIT License ([LICENSE](LICENSE)). Below are license notices for bundled third-party libraries and acknowledgments for open-source projects whose UI/UX patterns inspired Klanker's web workbench.

## Bundled Web & Desktop Dependencies

| Library | License | Copyright |
| --- | --- | --- |
| `@base-ui/react` | MIT | Copyright (c) 2019 Material-UI SAS — https://github.com/mui/base-ui |
| `@pierre/diffs` | Apache-2.0 | Pierre Computer — https://github.com/pierrecomputer/pierre |
| `react`, `react-dom` | MIT | Copyright (c) Meta Platforms, Inc. and affiliates. |
| `react-markdown` | MIT | Copyright (c) Espen Hovlandsdal |
| `remark-gfm` | MIT | Copyright (c) Titus Wormer |
| `remark-math`, `rehype-katex` | MIT | Copyright (c) Junyoung Choi |
| `rehype-prism-plus` | MIT | Copyright (c) 2021 Timothy Lin |
| `katex` | MIT | Copyright (c) 2013-2020 Khan Academy and other contributors |
| `mermaid` | MIT | Copyright (c) 2014 - 2022 Knut Sveidqvist |
| `lucide-react` | ISC | Copyright (c) 2026 Lucide Icons and Contributors |
| `clsx` | MIT | Copyright (c) Luke Edwards |
| `tailwind-merge` | MIT | Copyright (c) 2021 Dany Castillo |
| Tauri (`apps/desktop`) | MIT / Apache-2.0 | Copyright (c) The Tauri Programme within The Commons Conservancy |

Full transitive dependency versions and licenses are recorded in `apps/web/pnpm-lock.yaml`, `apps/desktop/src-tauri/Cargo.lock`, and `pyproject.toml`.

## Design & UX Acknowledgments

Klanker's monochrome web workbench components are implemented in this repository and draw architectural and UX inspiration from the following permissive open-source projects. If any source snippets are adapted in the future, upstream copyright and license notices are preserved here.

- **Synara** (https://github.com/cmdr-chara/synara) — MIT License, Copyright (c) 2026 T3 Tools Inc., Copyright (c) 2026 Emanuele Di Pietro — `@base-ui/react` monochrome primitive architecture, `@pierre/diffs` review flow, workbench side-rail layout, composer ergonomics.
- **Agents-Anywhere** (https://github.com/anywhere-labs/Agents-Anywhere) — Apache-2.0 License — `@base-ui/react` wrapper patterns and streaming tool-timeline ergonomics.
- **DeepSeek Chat Demo** (https://github.com/deepseek-ai/chat-demo) — MIT License, Copyright (c) 2026 DeepSeek — KaTeX/Mermaid chat rendering, collapsible reasoning accordion, attachment paste/drop and regenerate ergonomics.
- **Tuxee** (https://github.com/agent0ai/tuxee) — MIT License, Copyright (c) 2025 Agent Zero, s.r.o — lightweight file browser and terminal workbench UX.
- **openpoke** (https://github.com/shlokkhemani/openpoke) — MIT License — first-run onboarding starter-prompt cards.
