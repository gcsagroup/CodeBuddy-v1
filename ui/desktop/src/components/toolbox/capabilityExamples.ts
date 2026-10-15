// Examples describe intended use, not acceptance results for the current installation.
export const capabilityExamples: Record<string, [string, string, string]> = {
  qwencomputer: [
    '打开一个应用，观察窗口并操作指定控件。',
    '開啟應用程式，觀察視窗並操作指定控制項。',
    'Open an application, inspect its window, and operate a specified control.',
  ],
  computercontroller: [
    '读取 Excel 表格、处理 Word 或 PDF；Windows 桌面操作请使用电脑控制。',
    '讀取 Excel 表格、處理 Word 或 PDF；Windows 桌面操作請使用電腦控制。',
    'Read spreadsheets and process Word or PDF files; use Computer control for Windows desktop actions.',
  ],
  developer: [
    '读取项目文件，修改代码并执行测试。',
    '讀取專案檔案，修改程式碼並執行測試。',
    'Read project files, edit code, and run tests.',
  ],
  git: [
    '查看改动和提交记录，预览并执行已授权的版本控制操作。',
    '查看變更和提交記錄，預覽並執行已授權的版本控制操作。',
    'Inspect changes and history; preview and perform authorized version-control operations.',
  ],
  analyze: [
    '查找源文件中的函数与代码结构。',
    '查找原始檔中的函式與程式碼結構。',
    'Find functions and inspect source-code structure.',
  ],
  memory: [
    '保存或检索旧版全局记忆；与项目记忆分别存储。',
    '儲存或檢索舊版全域記憶；與專案記憶分別儲存。',
    'Save or retrieve legacy global memories, stored separately from project memory.',
  ],
  projectmemory: [
    '记住当前项目的约定，并在后续任务中查询。',
    '記住目前專案的約定，並在後續任務中查詢。',
    'Remember project conventions and retrieve them in later tasks.',
  ],
  codepromemory: [
    '检索项目活动记录，为后续任务补充上下文。',
    '檢索專案活動記錄，為後續任務補充上下文。',
    'Retrieve project activity records to provide context for later tasks.',
  ],
  skills: [
    '发现并加载适合当前任务的技能说明。',
    '探索並載入適合目前任務的技能說明。',
    'Discover and load skill instructions relevant to the task.',
  ],
  chatrecall: [
    '搜索过去的对话，找回讨论过的方案。',
    '搜尋過去的對話，找回討論過的方案。',
    'Search previous conversations for earlier decisions.',
  ],
  extensionmanager: [
    '查询扩展，并按任务需要启用或停用。',
    '查詢擴充功能，並按任務需要啟用或停用。',
    'Discover extensions and enable or disable them for a task.',
  ],
  summon: [
    '将独立子任务交给其他代理并收集结果。',
    '將獨立子任務交給其他代理並收集結果。',
    'Delegate independent subtasks and collect their results.',
  ],
  todo: [
    '保存并更新当前会话的任务清单；勾选不等于验收通过。',
    '儲存並更新目前對話的任務清單；勾選不代表驗收通過。',
    'Maintain a session checklist; a checked item is not proof of acceptance.',
  ],
  tom: [
    '将配置的常驻上下文注入模型请求，不提供可调用工具。',
    '將設定的常駐上下文注入模型請求，不提供可呼叫工具。',
    'Inject configured persistent context into model requests; this capability exposes no callable tools.',
  ],
  summarize: [
    '针对指定问题摘要文件内容。',
    '針對指定問題摘要檔案內容。',
    'Summarize selected files in relation to a question.',
  ],
  codeexecution: [
    '执行一段 TypeScript，并检查执行结果和错误。',
    '執行一段 TypeScript，並檢查執行結果和錯誤。',
    'Execute TypeScript and inspect its result and errors.',
  ],
  apps: [
    '创建和管理在独立窗口中运行的小工具。',
    '建立和管理在獨立視窗中執行的小工具。',
    'Create and manage small applications in isolated windows.',
  ],
  autovisualiser: [
    '将数据绘制成图表，核对图形类型和数据。',
    '將資料繪製成圖表，核對圖形類型和資料。',
    'Visualize data and verify the chart type and values.',
  ],
};

export function capabilityExample(key: string, locale: string): string | undefined {
  const entry = capabilityExamples[key.toLowerCase().replace(/[ _-]/g, '')];
  return entry?.[locale === 'zh-TW' || locale === 'zh-Hant' ? 1 : locale.startsWith('zh') ? 0 : 2];
}
