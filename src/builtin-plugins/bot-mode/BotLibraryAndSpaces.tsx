/**
 * 1:1 Meta Muse `资源库 (Library)` View (`BotLibraryView`):
 * `240px` left sub-sidebar (`搜索`, `文件` -> `空间/文档`, `影音内容` -> `图片/视频/播客`,
 * bottom `系统文件`) + clean 4-column table / space grid canvas.
 */
import { useState, type ReactElement } from "react";
import type { Context } from "@deepseek-ai/cordis";
import {
  ArrowUpRight,
  AudioLines,
  FileText,
  Folder,
  Globe,
  Image,
  Search,
  Trash2,
  Video,
} from "lucide-react";
import {
  openBotModal,
  patchBotUi,
  useBotController,
  useBotSnapshot,
  useBotUiState,
  type BotLibrarySection,
} from "./botStore";

const FILE_NAV: ReadonlyArray<{ readonly id: BotLibrarySection; readonly name: string; readonly Icon: typeof Globe }> = [
  { id: "spaces", name: "空间", Icon: Globe },
  { id: "docs", name: "文档", Icon: FileText },
];

const MEDIA_NAV: ReadonlyArray<{ readonly id: BotLibrarySection; readonly name: string; readonly Icon: typeof Image }> = [
  { id: "images", name: "图片", Icon: Image },
  { id: "videos", name: "视频", Icon: Video },
  { id: "podcasts", name: "播客", Icon: AudioLines },
];

const SYSTEM_DIRS: ReadonlyArray<string> = ["docs", "memory", "side-chats", "workspace"];

function formatBytes(len: number): string {
  if (len >= 1024) return `${(len / 1024).toFixed(1)} KB`;
  return `${len} B`;
}

export function BotLibraryView({ ctx }: { readonly ctx?: Context }): ReactElement {
  const ui = useBotUiState();
  const snapshot = useBotSnapshot();
  const ctrl = useBotController(ctx);
  const [filterText, setFilterText] = useState("");
  const [managingSpaces, setManagingSpaces] = useState(false);

  const q = filterText.trim().toLowerCase();
  const matches = (text: string) => q === "" || text.toLowerCase().includes(q);
  const filteredSpaces = snapshot.spaces.filter((sp) => matches(`${sp.title} ${sp.description}`));
  const filteredDocs = snapshot.documents.filter((doc) => matches(doc.name));
  const filteredMedia = snapshot.media.filter((m) => m.kind === ui.libSection && matches(m.title));

  const titleMap: Record<BotLibrarySection, string> = {
    spaces: "空间",
    docs: "文档",
    images: "图片",
    videos: "视频",
    podcasts: "播客",
    sysfiles: "系统文件",
  };

  return (
    <div className="qj-animate-page-in qj-muse-library-shell">
      <aside className="qj-muse-lib-sidebar" aria-label="资源库导航">
        <div className="qj-muse-drawer-search">
          <Search size={15} strokeWidth={1.8} aria-hidden="true" />
          <input
            type="text"
            value={filterText}
            onChange={(e) => setFilterText(e.target.value)}
            placeholder="搜索"
            aria-label="搜索资源库"
          />
        </div>

        <div className="qj-muse-lib-group">
          <div className="qj-muse-lib-group-label">文件</div>
          {FILE_NAV.map(({ id, name, Icon }) => (
            <button
              key={id}
              type="button"
              className={`qj-muse-lib-item${ui.libSection === id ? " active" : ""}`}
              onClick={() => patchBotUi({ libSection: id })}
            >
              <Icon size={16} strokeWidth={1.8} />
              <span>{name}</span>
            </button>
          ))}
        </div>

        <div className="qj-muse-lib-group">
          <div className="qj-muse-lib-group-label">影音内容</div>
          {MEDIA_NAV.map(({ id, name, Icon }) => (
            <button
              key={id}
              type="button"
              className={`qj-muse-lib-item${ui.libSection === id ? " active" : ""}`}
              onClick={() => patchBotUi({ libSection: id })}
            >
              <Icon size={16} strokeWidth={1.8} />
              <span>{name}</span>
            </button>
          ))}
        </div>

        <div className="qj-muse-lib-bottom">
          <button
            type="button"
            className={`qj-muse-lib-item${ui.libSection === "sysfiles" ? " active" : ""}`}
            onClick={() => patchBotUi({ libSection: "sysfiles" })}
          >
            <Folder size={16} strokeWidth={1.8} />
            <span>系统文件</span>
          </button>
        </div>
      </aside>

      <main className="qj-muse-lib-main">
        <div className="qj-muse-lib-head">
          <h1 className="qj-muse-doc-title">{titleMap[ui.libSection]}</h1>
          {ui.libSection === "spaces" && snapshot.spaces.length > 0 && (
            <button
              type="button"
              className="qj-soft-btn qj-sheet-pill-xs"
              onClick={() => setManagingSpaces((v) => !v)}
            >
              {managingSpaces ? "完成" : "管理"}
            </button>
          )}
        </div>

        {ui.libSection === "sysfiles" && (
          <div className="qj-muse-table" role="table" aria-label="系统文件列表">
            <div className="qj-muse-table-head" role="row">
              <span>名称</span>
              <span>类型</span>
              <span>上次修改</span>
              <span>大小</span>
            </div>

            {SYSTEM_DIRS.filter(matches).map((dir) => (
              <div key={dir} className="qj-muse-table-row static" role="row">
                <span className="qj-muse-table-name">
                  <Folder size={16} className="qj-muse-folder-icon" />
                  <span>{dir}</span>
                </span>
                <span className="qj-muse-table-cell">文件夹</span>
                <span className="qj-muse-table-cell">—</span>
                <span className="qj-muse-table-cell">—</span>
              </div>
            ))}

            {matches("SOUL.md") && (
              <button type="button" className="qj-muse-table-row" onClick={() => openBotModal("soul")}>
                <span className="qj-muse-table-name">
                  <FileText size={16} className="qj-muse-file-icon" />
                  <span>SOUL.md</span>
                </span>
                <span className="qj-muse-table-cell">Text</span>
                <span className="qj-muse-table-cell">{snapshot.soulUpdatedAt}</span>
                <span className="qj-muse-table-cell">{formatBytes(snapshot.soulContent.length)}</span>
              </button>
            )}

            {matches("MEMORY.md") && (
              <button type="button" className="qj-muse-table-row" onClick={() => openBotModal("memory")}>
                <span className="qj-muse-table-name">
                  <FileText size={16} className="qj-muse-file-icon" />
                  <span>MEMORY.md</span>
                </span>
                <span className="qj-muse-table-cell">Text</span>
                <span className="qj-muse-table-cell">{snapshot.memoryUpdatedAt}</span>
                <span className="qj-muse-table-cell">
                  {formatBytes(ui.memoryContent.length || 256)}
                </span>
              </button>
            )}
          </div>
        )}

        {ui.libSection === "spaces" && (
          filteredSpaces.length === 0 ? (
            <div className="qj-muse-doc-empty">还没有常驻空间</div>
          ) : (
            <div className="qj-sanctuary-bento-grid">
              {filteredSpaces.map((sp) => (
                <div
                  key={sp.id}
                  onClick={() => {
                    if (managingSpaces) return;
                    patchBotUi({ activeSpace: sp });
                    openBotModal("space-detail");
                  }}
                  className={`qj-soft-card qj-sanctuary-space-card${managingSpaces ? " managing" : ""}`}
                >
                  <div className="qj-sanctuary-space-meta">
                    <span>常驻空间</span>
                    <div className="qj-sanctuary-space-right">
                      <span>{sp.updatedLabel}</span>
                      {managingSpaces && (
                        <button
                          type="button"
                          className="qj-sanctuary-micro-btn danger"
                          title="删除空间"
                          aria-label="删除空间"
                          onClick={(e) => {
                            e.stopPropagation();
                            void ctrl.deleteSpace(sp.id);
                          }}
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="qj-sanctuary-idea-title">{sp.title}</div>
                  <div className="qj-sanctuary-idea-desc">{sp.description}</div>
                  <div className="qj-sanctuary-space-foot">
                    <span className="qj-sanctuary-space-metric">{sp.metricBadge}</span>
                    <span className="qj-sanctuary-space-link">
                      <span>打开</span>
                      <ArrowUpRight size={13} />
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {ui.libSection === "docs" && (
          filteredDocs.length === 0 ? (
            <div className="qj-muse-doc-empty">还没有归档文档</div>
          ) : (
            <div className="qj-muse-table" role="table" aria-label="文档列表">
              <div className="qj-muse-table-head" role="row">
                <span>名称</span>
                <span>类型</span>
                <span>上次修改</span>
                <span>大小</span>
              </div>
              {filteredDocs.map((doc) => (
                <button
                  key={doc.id}
                  type="button"
                  className="qj-muse-table-row"
                  onClick={() => {
                    patchBotUi({ activeDoc: doc });
                    openBotModal("doc-preview");
                  }}
                >
                  <span className="qj-muse-table-name">
                    <FileText size={16} className="qj-muse-file-icon" />
                    <span>{doc.name}</span>
                  </span>
                  <span className="qj-muse-table-cell">Markdown</span>
                  <span className="qj-muse-table-cell">{doc.updatedLabel}</span>
                  <span className="qj-muse-table-cell">{doc.sizeLabel}</span>
                </button>
              ))}
            </div>
          )
        )}

        {(ui.libSection === "images" ||
          ui.libSection === "videos" ||
          ui.libSection === "podcasts") && (
          filteredMedia.length === 0 ? (
            <div className="qj-muse-doc-empty">还没有{titleMap[ui.libSection]}</div>
          ) : (
            <div className="qj-sanctuary-bento-grid">
              {filteredMedia.map((m) => (
                <div key={m.id} className="qj-soft-card qj-sanctuary-space-card">
                  <div className="qj-sanctuary-idea-title">{m.title}</div>
                  <div className="qj-sheet-card-sub">{m.updatedLabel}</div>
                </div>
              ))}
            </div>
          )
        )}
      </main>
    </div>
  );
}
