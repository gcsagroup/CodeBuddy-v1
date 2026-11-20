# 按项目版本查询文档

用户任务涉及库、框架 API 或升级兼容性时，先读 package.json 与锁文件等版本来源，保留实际版本。使用 library_docs 的 search 操作找到库 ID，再用 query 操作查询对应文档。工具通过 search_mcp_tools 发现。出现鉴权或限额错误时报告原始状态，凭据只通过现有设置保存。

查询只发送库名、版本及必要的 API 问题，不发送项目源代码。存在对应版本时使用版本 ID。无版本匹配时注明文档版本差异，再核对官方版本文档。返回引用与适用版本，根据项目实际调用方式实施并验证。

连接超时或额度耗尽时，不要只改搜索词反复请求同一服务。改用已启用的官方网页检索渠道；备用渠道也不可用时，明确列出已确认的项目版本和无法在线核实的内容，结束本次查询，不把已有知识说成刚查到的官方证据。

繁體：先確認鎖定版本，再查對應文件並核對引用。連線或額度受阻時切換可用渠道，仍失敗則明確交代缺口，不反覆重試。
English: Resolve the installed dependency version, retrieve matching documentation, cite the source and verify the actual integration. Report missing connection or unmatched versions explicitly. Do not repeatedly rephrase queries after transport or quota failures; try an available official-source channel, then report the unresolved evidence gap if that also fails.
