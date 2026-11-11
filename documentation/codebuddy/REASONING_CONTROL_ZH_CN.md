# 思考预算与结束思考

默认文档为简体中文。另见 [繁體中文](REASONING_CONTROL_ZH_TW.md) / [English](REASONING_CONTROL_EN.md)。

## 采用范围

参考 pi-llama-cpp 的设计，将思考预算与整条回复的输出上限区分。保留项目已有官方 Harness / pi-ai 适配器，不安装另一套 Agent 执行核心，也不在客户端拼接思考结束标记。

目前适配 vLLM Chat Completions：服务的模型目录需明确标识 vLLM，且 OpenAPI 声明 `thinking_token_budget`。能力探测随连接目录缓存复用；拖动思考档位不触发生成请求。探测失败或未知服务沿用原协议，不试发不支持的参数。

预算为 minimal 256、low 1024、medium 2048、high 8192 个思考 token；当前锁定的原生适配器将 xhigh/max 预算映射到 high。关闭思考不发送预算。用户选择的思考档位仍保留；预算是附加上限。原生序列化器会为答案保留输出空间，不能用降低总 `max_tokens` 代替思考预算。

服务器负责实际执行上限。OpenAPI 声明只证明参数存在，不证明模型解析器配置正确；token 数也不能保证固定的等待秒数。必须通过真实流式请求及任务结果验收。

## 未采用的部分

pi-llama-cpp 的即时 `reasoning_end` 请求依赖 llama.cpp 的控制接口。当前 vLLM 和 Ollama Kimi 连接没有验证过等价接口，因此不显示一个实际无效的“立即结束思考”按钮，也不静默降低 Kimi 的选定档位。

未来接入控制接口时，必须按具体会话、运行轮次和 completion ID 定位原请求，验证响应中的成功字段；不能只看 HTTP 200，也不能按当前模型下拉框定位正在运行的旧请求。

结束思考不代表成功执行。零工具调用、文件未写入、失败命令、权限拒绝及导出缺字段需要各自的修复与验收。

## 验证与来源

2026-11-09 的真实 Gemma 服务探测中，预算 64 时思考字段约为 62 token，但模型继续在正文中推演，最终耗尽 2048 个输出 token，未给出要求的简短答案。因此，结束思考块不等于结束推演，也不能把预算越低解释为体验越好。真实项目验收还发现固定返回成功的检查器；该问题必须由执行及验证回执检查独立处理。

`runtime/tests/vllm-thinking.test.mjs` 覆盖原生请求序列化、关闭思考、缓存、未知服务及 Gemma 旧模板忽略 `reasoning_effort` 的兼容分支。自动测试通过不等于 Windows/macOS 安装包验收通过。

- [pi-llama-cpp reasoning control](https://github.com/gsanhueza/pi-llama-cpp#reasoning-control)（MIT；本次只参考机制，没有复制代码）
- [llama.cpp server API](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md)
- [vLLM reasoning outputs](https://docs.vllm.ai/en/latest/features/reasoning_outputs/)
