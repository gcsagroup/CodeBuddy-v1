# 內建技能目錄候選驗證

限定結果：三檔案修復可隨候選原始碼分發，include_dir 巨集編譯恢復；乾淨候選原始碼的 Rust workspace 建置通過。乾淨候選的桌面 package/installer 仍未執行。

逐一核對既有差異：builtin.rs 新增 16 行測試，Windows workflow 新增 9 行目錄追蹤檢查，.gitkeep 為一個換行；三檔案與初次審計凍結雜湊相同。只使用独立暫存索引，未修改真實索引、提交、建分支或推送。

歸檔 3617 個項目，以 Python 3.12 tarfile 的 UTF-8/data filter 解壓；所有普通檔案內容雜湊吻合。Windows tar.exe 無法處理部分中文名稱的失敗保留為工具環境問題。歸檔 builtin.rs 在歸檔 builtins 目錄下編譯 exit 0，測試 1 通過/0 失敗/0 忽略；HEAD 缺目錄對照如預期產生巨集錯誤。重用現有 include_dir 編譯依賴，未複製 target。

HEAD: `e7856bc14aa99e11d52acc88d109a67e2590fdbe`

Candidate tree: `bef4f38ad95bd042be1d74d032af9e903fc88c9a`

Real index before/after SHA-256: `D02F76FCFA339DC8C6D9EF2EB1EEE270EF35F0EFEC93189121FAAEBDCB70BB51`

Evidence: `.cargo/evidence/audit-fixes-20260914/clean-windows-candidate-summary.json`, `clean-builtins-candidate-20260915-final/candidate.patch`, `archive-utf8-manifest.json`, `macro-result.json`.

在 `clean-builtins-candidate-20260915-final/source-utf8` 執行 `cargo build --workspace --jobs 1`，exit 0，45 分 54 秒。候選來源透過 `GIT_CEILING_DIRECTORIES` 隔離，不會讀取父層髒倉庫；使用 `D:/CodeBuddy/target` 的既有依賴快取，因此這是乾淨來源完整 Rust workspace 建置，不是空 target 從頭建置。證據：`clean-workspace-build.log`、`clean-workspace-build.json`。

Clean Rust workspace build: **PASS**. Clean desktop/package build: **NOT_RUN**. GitHub updated: **false**.
