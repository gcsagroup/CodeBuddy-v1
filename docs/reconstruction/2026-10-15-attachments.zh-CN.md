# 附件、识图设置与执行前审批验收（2026-10-15）

在 D:\CodeBuddy-v1 完成，目录无 .git，保留复制基线及未提交修改。仅修改前端适配/设置；Harness 执行、调度、完成、压缩及既有能力配置 owner 不变。无分支、提交、推送、依赖安装，原用户 runtime20048 未动。

## 修复

- ChatInput 窄于480px时原先隐藏附件按钮。现在始终保留附件并提供可访问名称，右侧工作区打开时真实验证可用。
- 后端已有 model-capabilities/read/save/resolve，但设置无入口，能力未知时在请求模型前拒绝图片。新增 ModelImageCapabilitySettings，选择已配置厂商/模型并明确声明识图能力；保存前读取最新配置保留其他模型声明，发现结果不自动授予能力，失败保留选择并支持重试。中英繁文案齐全，其他语言英文回退。
- 内联审批未显示实际文件目标。现在与独立审批共用 ToolApprovalTarget，消费审批请求的结构化参数，支持 Harness read/write/edit 的 file_path、bash 的 command，兼容旧字段。不改变权限或执行判定。

## 验证

最终前端6文件112/112、exit0，attachment-complete-final.log。TypeScript、目标ESLint、i18n提取/编译/一致性均exit0。先红回归：窄布局1失败/23通过；审批目标2失败/28通过。新增测试初次缺少模型name、lint类型声明、其他语言缺键已修复，失败日志保留。Node22与声明Node24警告未通过改变环境规避。后端/Rust未改，复用05:26的360/360及构建证据，不声称新跑。

真实Electron+Kimi会话 fb0759a6-7952-4c8f-b340-498e62785dbe：

1. 能力未知时图片被明确拒绝；真实设置保存kimi-k3支持图像后，主模型准确识别PIC-C384A761、红圆/蓝方、17和29及和46，零工具调用，Harness正常完成。
2. Kimi经Harness/qwen_computer操作原生文件选择器，仅允许window:19552:235539488；5动作、end_turn/exit0。中文采购清单路径真实进入输入框，批准一次read后读出DOC-25e04136ca3f、商品及运费，总额9443分。
3. 数量7改为9、商品九折按分四舍五入、运费不打折，正确计算10872分，图片事实仍保留。
4. 页面重载追问，准确保留两类随机标记、数量9、总额10872及运费约束。四轮均completed/harness_turn，仅一次文件读取。历史保留两份实际JPEG（各12412字节），并非仅文字描述。
5. 审批展示修复后，再次read在执行前显示完整路径；点击拒绝，原生isError=true、Tool execution was declined，模型结束，无第二次尝试或文件内容返回。

证据：.preview-evidence/real-skills-4e2BOF/foundations-ui-receipt.json.attachments、attachment-*.png、native-export-probe-VtqnEf/receipt.json、native-attachment-real.log。Playwright合成文本文件没有Electron磁盘路径，早先空值属于验收机制，原生选择器已验证，未当产品故障。图片使用file input及真实文件字节。

## 边界

识图声明保留在隔离验收profile，原用户配置未改。辅助视觉仍未配置，本轮复用此前专项降级证据。文件按钮走本地路径+批准read，未证明上传副本回执；四轮保持不替代既有十二模块、多次压缩证据。

第五轮还发现顶部将整轮完成误标为所有操作完成，现已修复：ProgressiveMessageList只有真实工具回执全部成功才使用完成标签，拒绝/失败/缺回执显示中性记录。先红2失败/37通过，真实重载后“本轮记录1项操作”、内部“1项操作未成功”及失败单项均正确；不改变Harness完成判定。macOS、安装包、复杂配方及其他矩阵缺口仍待处理。

当前为隔离开发预览runtime7580/exec69369、CDP9395，前端由当前源码Vite加载；源码指纹overnight-source-attachments.json。不是安装包交付。
