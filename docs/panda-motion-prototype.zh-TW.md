# 小熊貓自然動作樣板

> 2026-11-10 使用者否決分部位生成、拼接的視覺方案。此文件記錄已否決樣板，不作為後續完整角色連續動畫的視覺或性能證據，不整合至正式桌寵。

2026-11-10；來源：`D:\CodeBuddy-v1`，`main / b7865d54` 加未提交樣板。未建立分支、安裝依賴、提交、推送或替換正式桌寵。

`ui/desktop/src/pets/prototype/` 使用 Canvas2D 分層骨骼變換，未使用 Spine SDK 或網格蒙皮。提供待機、滑鼠觀察、揮手及跳躍，支援動作打斷與過渡。眨眼切換開眼／閉眼頭圖，尚無獨立眼球及連續眼瞼。

在 `ui/desktop` 執行 `node scripts/preview-panda-rig.cjs` 開啟本機預覽；執行 `node scripts/preview-panda-rig.cjs --export` 產生可離線雙擊開啟的 `.local/panda-rig-review/panda-preview.html`。同目錄包含實際錄影、截圖與性能 JSON。錄影為 25 fps，不代表渲染器幀率。

Windows Edge、1100×870、DPR 2，不錄影的 40 秒測試：320px／15 秒平均 56.25 fps，160px／10 秒平均 56.38 fps，160px 且 CPU 降速 4 倍／15 秒平均 56.30 fps。各窗口繪製耗時 P95 最大值分別為 0.30／0.30／1.60 ms，幀間隔 P95 最大值為 18.6 ms，未記錄到超過 50 ms 的幀。含錄影／截圖的另一次測試出現少量長幀。JS 堆快照約 2.39 → 1.96 MB，不含全部圖像／GPU 記憶體；短測試不能證明長期無洩漏。降速不是獨立低階硬體測試。

素材僅載入與裁切一次，動畫循環不讀取 alpha、不更新 React；DPR 上限 2；按時間推進，隱藏時暫停，減少動畫時停止繪製，銷毀時取消 RAF 和監聽器；最多保留 180 條性能採樣。

最終檢查退出碼均為 0：`corepack pnpm run test:run src/pets/prototype`（7 項）；`corepack pnpm exec playwright test tests/e2e/panda-rig.browser.spec.ts --reporter=list` 的兩個場景分開執行通過（第二項以 `-g 'without recording'` 執行）；`corepack pnpm run typecheck`；`corepack pnpm exec eslint src/pets/prototype/*.ts --max-warnings 0`；相關 Prettier 檢查；離線匯出。涵蓋跳躍不裁切、打斷、觀察速度、減少動畫、隱藏／恢復、釋放資源與幀預算。Node 22 與宣告 Node 24 有版本警告，未變更環境。

完整 Electron、跨平台及長時間驗收未執行；正式透明視窗、點擊穿透與整體記憶體仍需整合後測試。此為使用者評估的獨立樣板，沒有把自動化通過當成視覺驗收。

原創小熊貓分層素材由內建 imagegen 產生，提示見 `assets/provenance.json`。參考 [Spine](https://en.esotericsoftware.com/spine-weights)、[Live2D](https://docs.live2d.com/en/cubism-editor-manual/about-fade/) 與 [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas)，未複製素材／程式碼或引入商業執行庫。
