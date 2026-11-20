# 代码定义与引用查询

用于跨文件追踪函数、类型和调用关系。先确认当前工作区与语言。通过 search_mcp_tools 查找 code_navigation。使用 overview、definition、references 操作，只读查询工作区的相关文件和符号，传入 path 及必要的 symbol。限制结果范围，按调用关系补充证据。不得把同名文本匹配当作引用关系。

CodeBuddy 选用官方最后 MIT 修订 74c38a65f03fc0764d7ee4b3016ef6a07572ed64。源码标注为 1.7.1.dev0，不能把它报告为 v1.7.0 发布包。连接缺失或语言服务未就绪时报告具体状态，不能宣称查询成功。修改代码仍使用工作区现有编辑和权限机制。引用结果受到项目配置及语言服务解析能力限制。

繁體：從符號定義追蹤引用，核對工作區和語言服務狀態。
English: Use Serena's read-only symbol and reference queries in the current workspace. Confirm language-server readiness and distinguish semantic references from text matches.
