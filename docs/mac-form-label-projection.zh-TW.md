# Mac 本機 FORMS 標籤映射

[简体中文](mac-form-label-projection.zh-CN.md) · [English](mac-form-label-projection.en.md)

主模型解釋中文欄位含義並提供英文評分標籤，FluidUse/CUA-S1-FORMS 在 Mac 本機評分，既有原生工具執行主模型選擇的輸入。不增加網路模型、輸入權限或自動提交。

已發布的小模型主要依賴訓練詞彙；實測 `Work email` 會跳過，`Email` 才能匹配。中文表單標題及既有內容也會影響結果。不得清空舊值來強迫模型建議填寫。參考：[模型說明](https://github.com/trycua/cua/blob/main/libs/cua-s1/MODEL_CARD.md)、[訓練概念](https://github.com/trycua/cua/blob/main/libs/cua-s1/python/src/cua_s1/concepts.py)。

先用 `get_app_state` 觀察準確視窗，再對相同視窗傳入原始 `form_entities` 和可選 `form_labels`：

```json
{"app":"window:42:8","form_entities":[{"label":"公司","value":"海風測試"},{"label":"工作信箱","value":"qa@example.test"}],"form_labels":{"title":"Customer Form","fields":[{"element_index":"18","label":"Company"},{"element_index":"23","label":"Email"}],"entities":["Company","Email"]}}
```

範例編號必須換成實際觀察的編號。`title` 只影響評分，缺省使用原標題；`fields` 只列已釐清的目標，未列欄位不評分。同名信箱無法區分時不映射。`entities` 與原資料順序一致，英文標籤最多 64 ASCII 位元組且必須不同，不得把不同收件人合併。原標籤、舊值及填寫值均保留；回執分別呈現原標籤、評分標籤、目前值與真實機率，未推理欄位不偽造機率。

Go 依目前快照綁定原生身分；Swift 在推理前核對視窗、邊界、所有帶名稱或值的節點，以及全部可編輯欄位的身分、名稱、值與位置。無名稱、無值且不可編輯的裝飾節點不參與翻譯上下文比較，避免 Safari 增減空 AXGroup 造成假失效；空白或無名的可編輯欄位仍保留，目標原生路徑仍須完全一致。欄位、附近標籤或草稿改變時，舊映射失效，只回傳新觀察和匹配不可用原因，不輸入、不重播。無效的可選映射只降級匹配，不能靜默改用原始標籤；沒有映射的舊呼叫仍保留原行為。映射不新增持久狀態。

主模型仍負責範圍、歧義及動作判斷；skip 不是授權裁決。儲存按鍵送達、界面狀態與磁碟結果應分開核對。測試涵蓋真實 CoreML 中文推薦、保留未映射欄位、失效映射、重複別名、舊呼叫及編號重映射；產品驗收以本批真機記錄為準。
