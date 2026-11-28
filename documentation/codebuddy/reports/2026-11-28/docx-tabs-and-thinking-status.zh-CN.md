# DOCX 预览、侧栏标签与思考顿挫调查

日期：2026-11-28。目录 `C:\Users\admin\Documents\ChatGPT\codebuddy-v1`；分支 `codex/fix-streaming-navigation-20261128`，HEAD `bcc6ab77731cc6f1c67985a83f71f1ecb0e41d15` + dirty。用户撤回再次重启的要求，本批未重启桌面、未提交、未推送，保留前批已验收及原有 dirty。

后续结算：上述HEAD/dirty为调查阶段快照。用户随后授权审查剩余改动并本地提交；本报告两个标签CSS提交为`ace75ebb`。最终384项前端回归含WorkspacePanel/WorkspaceDocument通过，类型检查exit0；详细合并交接追加在[11月27日交接第10节](../2026-11-27/follow-up-steering-handoff.zh-CN.md)。本机LibreOffice EXE的完整性标签修正不随Git传播，未添加自动改权限代码；没有把源码CSS提交称为干净安装包DOCX验收。

## 本批结果

| 对象 | Before | After |
| --- | --- | --- |
| 默认后续消息模式 | `defaultSettings.followUpMode` 与 `useFollowUpMode` 已默认 `steer` | 核对并保留，不覆盖用户显式保存的排队选择 |
| 本机 DOCX 转换器 | EXE 继承 Low 标签，真实子进程 RID 4096；最小 DOCX 转 PDF 写临时文件失败 | 用户明确批准后，仅该 EXE 改 Medium；真实子进程 RID 8192，最小及用户原文件转换成功 |
| 侧栏标签 | 依赖较浅的选中底色/阴影，未选中项缺少稳定边界 | 每项 1px 主题边框和主题主底色，选中边框稍增强；移除旧选中阴影，保留原点击/关闭/滚动逻辑 |
| 思考过程顿挫 | 前批已改善正文缓存和滚动，长思考仍顿挫 | 本批继续只读对照和既有会话分析；未更换 renderer、修改持久化或增加显示缓冲 |

## DOCX：真实故障及受控环境修复

调用链为 `WorkspaceDocument` → Electron `workspacePanel` 的 `document-preview` → 当前 `DocumentPreviewer.render` → 官方 DSH `OfficeToPdf` → `libreoffice-kit` 原生 helper → PDF.js 展示。权限、文件版本检查与大小限制由现有桌面 owner 负责，队列、转换、取消、私有 scratch 清理由官方服务负责，本批未改这些模块。

当前预览日志存在真实错误 `loadComponentFromURL returned an empty reference`。使用纯自建最小 OpenXML 文档，运行 `node .local/docx-tabs-20261128/repro-docx.mjs`，得到真实转换失败、exit 1，具体落在输出 PDF 时 `SfxBaseModel::impl_store ... 0x507(Error Area:Io Class:Access Code:7)`。两者错误阶段不同，不能先把它们视为完全相同的内部异常。

进一步确认：

- 唯一目标为 `runtime/harness/node_modules/@deepseek-ai/libreoffice-kit-win32-x64/bin/libreoffice-kit.exe`，只有一个硬链接；SHA256 与固定 0.1.5 官方 prebuild 清单一致。
- 修改前实际 Node 父进程 RID 8192（Medium），两个实际 helper 子进程 RID 4096（Low）；EXE 的 `icacls` 为继承 Low。临时目录未标记，按 Windows 规则视为 Medium。Windows 会以用户与可执行文件较低的完整性启动新进程，Low 不能写 Medium 对象。[微软 MIC 文档](https://learn.microsoft.com/en-us/windows/win32/secauthz/mandatory-integrity-control)
- 用户明确批准仅这个 EXE 的 Low→Medium 后，执行 `icacls <该精确路径> /setintegritylevel M`，exit 0。前后内容 SHA、owner/group/普通 DACL 的 SDDL 完全相同；没有改其他文件、目录、PATH、全局权限或上游版本。
- 同一监测与转换命令复测，Node/helper 均为 RID 8192，最小文档成功，PDF 20658 字节，转换约 1270ms。中文同内容样本随后 1ms 返回，可能命中服务缓存，不计作第二次独立 native 转换。
- 再用用户原“厨师长”文档运行独立 `DocumentPreviewer.render`：约 2031ms，PDF 411403 字节、文件头 `%PDF-`，源 DOCX SHA 未变，exit 0。至此同机转换故障已通过受控变化和原文件复测；不是只用 mock renderer 证明成功。

证据在 `.local/docx-tabs-20261128/`：`native-label-before.json` / `native-label-after.json`、`process-integrity.json`、`repro-result.json`、`user-document-result.json`。监测第二次运行覆盖了原 token/result 文件，故修复前记录另存 `before-observed.json`，明确标为本聊天真实工具回执的转录（f07612、9b8883），不是保留的原始日志或新跑的一次测试。

这是本机文件安全元数据的修复，**不会随 Git 提交传播**；没有在产品里添加自动改权、全树扫描或转换 fallback。重新生成载荷若再次继承 Low，需要先按同一诊断边界核实，不能将单文件授权扩大成目录批量修复。

## 标签栏的范围与检查

仅改两个产品 CSS 文件：

1. `ui/desktop/src/workspace-panel/workspacePanel.css`：`.wb-tab` 增 1px 边框与主题主底色，radius 7→8px，垂直 padding 6→5px 补偿上下边框，选中边框用已有颜色混合加强。
2. `ui/desktop/src/styles/desktop-shell.css`：移除选中标签旧阴影，保留主题主底色。

每项宽度理论增加 2px，原横向滚动与 `flex-shrink: 0` 继续处理溢出；没有声称宽高逐像素均不变。没有修改标签存储、Tab 关闭、脏文件确认、文件读取或右侧栏协议。

实际验证：

```powershell
# cwd: ui/desktop；只使用此前已授权的现存依赖
node ../node_modules/vitest/vitest.mjs run --maxWorkers=1 src/workspace-panel/WorkspacePanel.test.tsx src/workspace-panel/WorkspaceDocument.test.tsx src/hooks/useFollowUpMode.test.tsx
# cwd: 仓库根
node .local/docx-tabs-20261128/tabs-visual.mjs
git diff --check
```

- 三个现有 Vitest 目标 64/64，exit 0；JSDOM 的 `HTMLMediaElement.pause` 提示不影响结果。
- 真实产品 CSS/主题变量的隔离 header 夹具在 640/380px、深/浅色共四状态通过：header 48px、边框可见、选中边框有区别、横向溢出不撑宽整个栏、关闭按钮保留、键盘 focus 2px。已查看渲染截图。此为 CSS-only 夹具，**不是完整 WorkspacePanel/Electron E2E**。
- 视觉夹具前两次本地 Vite 未响应，已终止唯一自有夹具进程；限定 desktop root、关闭一次性夹具的目录监听并限定入口后四状态 exit 0。未改产品 Vite 配置或构建环境，不将夹具失败算作产品缺陷。
- 使用已存在的 Impeccable 0.1.18 缓存工具，未下载：context 允许局部精修；一次 mechanical detect 返回 `[]`、exit 0。未生成 PRODUCT/DESIGN 或改产品风格。
- 独立审查无 Required；同时指出尺寸和缓存证据边界，已在本记录保留。

当前 Computer Use 枚举不到可操作的 CBD 窗口，但既有 launcher/runtime/Electron 进程仍在。遵守用户撤回重启的要求，没有为了截图重新启动、构造 DOM 或把组件检查写成桌面验收。旧失败预览需要点击刷新，或关闭该文档标签后重新打开；实际右侧栏 PDF 显示仍待窗口恢复后验收。

## 思考顿挫：本轮已确认与尚缺

已亲读本项目代码，确认展开思考未启用正文的 `animateIncoming` 路径，仍使用完整 `MarkdownDocument`。缓存 raw Markdown 解析前缀之后，`StreamingMarkdownParser.parse` 仍会克隆完整树，下游插件与 ReactMarkdown 仍处理完整文档。前批稳定文件 Context 可避免已完成正文块失效，不能等同于已缓存思考的完整 React 元素树。[React memo 的边界](https://react.dev/reference/react/memo)

另一个已确认链路是兼容更新先由 `writer.append` 持久化，再发 `connection.notify`；journal 的每条记录执行 `writeFile` 和 `sync`，且调用串行。**尚未测出它的排队/耗时贡献**，不能据此认定磁盘就是根因，更不能删持久化来换取跑分。

本轮对既有真实 GLM 夹具会话作离线时间统计：

| 推理段 | 长度（UTF16） | DSH 接收点 chunk 数 | 到达间隔 P95 / P99 / 最大 |
| --- | ---: | ---: | --- |
| 第 2 轮 | 62250 | 9395 | 54 / 324 / 1006ms |
| 第 3 轮 | 31318 | 2808 | 40 / 334 / 715ms |

存在大量同毫秒交付及数百毫秒间隔，说明这一接收点的节奏已有成批特征。时间戳是本机 DSH 接收时刻，**不是服务端网络时刻，也不是 UI 每帧绘制时刻**；不能把所有停顿归给模型服务商。两段均无 ≥2500ms 的 source 空窗，现有 2.5 秒 idle-fold 不能直接解释这两段的 source 记录；UI 延迟和其他会话仍需另测。

后续实验应以同一输入串联 `DSH 收到 → 事件串行队列 → journal sync → 发 UI → React commit → frame`，分别记录积压与耗时，再用相同 trace 做显示侧对照。WorkBuddy 的展示通知合并与 DSH 的完成块复用可作为候选；不延迟权限/停止等控制事件，不合并丢弃真实持久记录，不以公开 Codex TUI 推断桌面私有实现。本批没有新增性能补丁。

| 对照实现 | 本轮能核实的差别 | 复用边界 |
| --- | --- | --- |
| 本机 WorkBuddy 5.9.2 | 根与独立审查均只读核对实际 `app.asar` 中 `contexts-B89VvUPd.js`，SHA `e5f23bdc77670fd4ea47fa7a8eac7df36cabcf476e8a02be0fbff22b7c39195d`；单 pending rAF 保存最新展示 snapshot，hidden 切 timer，unsubscribe 清理 | 可作为展示订阅合并候选；未还原其完整思考 renderer，不宣称使用同样库就能得到同样效果 |
| 固定 DSH 0.2.1-alpha.2 | 默认 ReasoningContent 实接 MarkdownText，冻结完成块的 React 元素，保留活动尾部；比 CBD 只缓存 raw AST 多一层复用 | 公共组件与当前自定义路径/文件回执/引用插件并非无损替换；缺依赖、晚到引用、选择与焦点须独立验证 |
| Codex | 独立审查核对公开 app-server 的分类型流式事件与最终项合同 | 当前没有取得桌面思考渲染实现；公开 TUI 不作为桌面源码证据 |

独立调查全文及完整源码/包 hash、分段实验计划在本地 `.local/docx-tabs-20261128/thinking-review.md`，时间统计脚本 `analyze-thinking-trace.cjs` 实际 exit 0。它是既有夹具会话的离线分析，不是这次用户会话的新性能 trace。后续优先先分段测量，再比较按帧发布与完成元素复用；不为“看起来顺”增加人工打字队列。
