# 内建技能目录候选验证

限定结果：三文件修复可随候选源码分发，include_dir 宏编译恢复；干净候选源码的 Rust workspace 构建通过。干净候选的桌面 package/installer 仍未运行。

逐一核对已有差异：builtin.rs 新增 16 行测试，Windows workflow 新增 9 行目录跟踪检查，.gitkeep 为一个换行；三文件与初次审计冻结哈希相同。只使用独立临时索引，未修改真实索引、提交、建分支或推送。

归档 3617 个条目，以 Python 3.12 tarfile 的 UTF-8/data filter 解压；所有普通文件内容哈希吻合。Windows tar.exe 无法处理部分中文名称的失败保留为工具环境问题。归档 builtin.rs 在归档 builtins 目录下编译 exit 0，测试 1 通过/0 失败/0 忽略；HEAD 缺目录对照如预期产生宏错误。复用现有 include_dir 编译依赖，未复制 target。

HEAD: `e7856bc14aa99e11d52acc88d109a67e2590fdbe`

Candidate tree: `bef4f38ad95bd042be1d74d032af9e903fc88c9a`

Real index before/after SHA-256: `D02F76FCFA339DC8C6D9EF2EB1EEE270EF35F0EFEC93189121FAAEBDCB70BB51`

Evidence: `.cargo/evidence/audit-fixes-20260914/clean-windows-candidate-summary.json`, `clean-builtins-candidate-20260915-final/candidate.patch`, `archive-utf8-manifest.json`, `macro-result.json`.

在 `clean-builtins-candidate-20260915-final/source-utf8` 执行 `cargo build --workspace --jobs 1`，exit 0，45 分 54 秒。候选源码通过 `GIT_CEILING_DIRECTORIES` 隔离，不会读取父级脏仓库；使用 `D:/CodeBuddy/target` 的既有依赖缓存，因此这是干净源码完整 Rust workspace 构建，不是空 target 从头构建。证据：`clean-workspace-build.log`、`clean-workspace-build.json`。

Clean Rust workspace build: **PASS**. Clean desktop/package build: **NOT_RUN**. GitHub updated: **false**.
