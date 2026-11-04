# 自定义智能体配套 Skill

这些资源随 CodeBuddy 提供，使用锁定版本的 DSH Skill 注册表与文件解析器加载。默认模板可直接选用；浏览和选用不创建用户定义、会话或目录，自定义后保存才生成可编辑的独立副本。六个默认模板的当前版本为 revision 2，旧会话和用户副本不自动更新。

| 默认模板 | 配套 Skill |
| --- | --- |
| 高级开发工程师 | debug、code-review、testing-strategy |
| 前端开发工程师 | frontend-design、testing-strategy、design-system、ux-copy |
| UI 设计师 | frontend-design、design-critique、design-system、design-handoff、ux-copy |
| 产品经理 | write-spec、synthesize-research |
| 数据分析师 | explore-data、validate-data、data-visualization |
| 内容创作专家 | content-creation、brand-review |

配套技能不是每题必读清单。视觉创作、产品评审、实施交付和营销写作各有适用范围，角色按当前用户任务选取。普通润色不需要工程流程，内部说明不必套营销模板，单项计算不必绘图。技能目录不授予外部服务访问，也不代表依赖或连接器已经安装。

Skill 在所选主角色的原生 Agent 作用域注册。未选用角色时不进入该会话的模型技能目录；主角色挂载不会自动传给子智能体。选择配置保存与实际生效仍遵循会话角色的既有用户输入边界。切换或撤销时刷新原生目录，旧加载回执和聊天历史保留，不承诺模型遗忘已读内容。

只注入可用技能的摘要，正文由模型按任务调用 `skill` 后读取。沿用对话能力的角色也可单独调整配套 Skill；该设置不会自动启用 MCP、改变模型、安装依赖或增加工具授权。

## 来源与适配

- `frontend-design`：<https://github.com/anthropics/skills>，固定 revision `ca45fc496a3436251f191354091d557da31c15b5`。Apache-2.0，许可证保存在对应目录的 `LICENSE.txt`。
- 其余十四个 Skill：<https://github.com/anthropics/knowledge-work-plugins>，固定 revision `2574e29377c7173d0cecffef29a6ecbd7f8ccb5d`。Apache-2.0，完整许可证为 `LICENSE.knowledge-work-plugins.txt`。

保留原文。唯一文档适配是把引用的 `../../CONNECTORS.md` 移到同一技能目录，修改为 `CONNECTORS.md` 并带上原文件，保证资源包内部可解析。连接器文档用于解释通用工具类别，不表示这些服务已在 CodeBuddy 接入。

原生注册名使用 `codebuddy-` 前缀，避免替换用户已经安装的同名上游 Skill。原始文档的 frontmatter 名称不变，由现有文件解析器读取后映射到注册名。`manifest.json` 保存名称、说明和来源；`PROVENANCE.json` 保存固定版本、原始及适配后的 SHA256。没有复制上游插件运行时、Hooks、脚本或市场配置，也没有自动更新器。
