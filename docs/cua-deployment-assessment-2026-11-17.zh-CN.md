# CUA 本地部署评估与 API 验证

日期：2026-11-17。源码：`D:\CodeBuddy-v1`，`main@4c8afad978b6e893a3545c0859dd5b4824a91223`，包含既有未提交改动。本次未切换分支、提交、打包或修改用户的模型设置。

## 结论与实际交付

当前继续使用已经内置配置的远端 CUA API：`http://192.168.9.101:8001`，模型 `CUA-S1-Qwen3.5-4B`。主模型仍是 `deepseek-v4.1-flash:1017`，未修改主模型或思考强度。CUA 通过受限的观察会话识图，没有桌面操作工具；主模型依据控件回执与辅助图像说明做判断，原 MCP 执行动作。

本机的系统内存足以尝试 Q4 CPU 推理，但本次没有完成本地模型推理，不能声称本地跑不动，也不能声称本地已通过验收。现有 GPU 运行环境未通过检测；下载速度限制了 CPU 实测。按用户允许的 API 路径保留可用服务，未将未经验证的本地服务设为默认。

## 实测硬件与模型文件

| 项目 | 本次读取的结果 |
| --- | --- |
| CPU | AMD Ryzen 7 4800H |
| 系统物理内存 | 33,685,835,776 字节，约 31.37 GiB |
| 当时可用内存 | 约 10.38 GiB；会随运行程序变化 |
| GPU | GTX 1650 Ti，4,096 MiB 显存，当时占用 519 MiB |
| NVIDIA 驱动 | 457.49 |
| D 盘可用空间 | 约 82.13 GiB |
| 已安装运行时 | Ollama 0.40.16；附带 llama-server 0.9.0-dev，commit 6c01da627 |

[指定仓库](https://huggingface.co/GCSA-AiLab/cua-s1-4b-0.2-GGUF-MLX/tree/main/GGUF)的固定 revision：`01b53a83a8d492000e83ce69835d4c21c6c09be7`。

| 文件 | 大小 |
| --- | ---: |
| Q4_K_M 语言模型 | 2,741,242,176 字节，2.55 GiB |
| 配套 F16 mmproj | 672,423,392 字节，0.63 GiB |
| 两者合计 | 3,413,665,568 字节，3.18 GiB |

文件大小不等于峰值运行内存：还需视觉计算缓冲、上下文缓存和服务内存。4 GB 显存不足以据此保证整个识图过程都在 GPU 上运行。Q6/Q8 占用更高，本轮没有下载。MLX 目录用于 Apple Silicon，Windows 应评估 GGUF。

仓库说明：Qwen3.5-4B 与原始 multimodal LoRA 已合并；视觉权重也经过合并，必须使用同仓库的 mmproj，不能换成基础模型的投影。仓库标注 Apache-2.0，分发时需保留许可和归属。转换者只报告简单图像生成检查，没有重新证明量化版的完整电脑操作成功率。

## 本地检查结果与边界

- 已安装 Ollama 的 GPU 检测出现 watchdog 超时，最终报告 CPU 推理和 `total_vram=0 B`。这是当前运行环境的实测结果，不代表 GTX 1650 Ti 在任何环境都不受支持。
- [Ollama 官方硬件说明](https://docs.ollama.com/gpu)列出 GTX 1650 Ti，并要求 NVIDIA 驱动 550 或更新；本机 457.49 不满足该条件。未修改驱动或系统环境。
- 官方源下载及镜像小段探测约为 0.1 MB/s，未完成 3.18 GiB 权重下载。停止本次下载，部分文件以 `.part` 保留，不能用于推理或作为权重校验通过的证据。测试启动的 Ollama 进程已停止。
- 本地冷启动、峰值内存、截图延迟及识别质量均为**未测**，没有用估算数值代替实测。
- 若继续本地部署，须先完成固定 revision 权重下载和 SHA-256 校验，再用同一批截图比较本地和 API，最后通过既有 OpenAI-compatible provider 接入；不另建 Agent 核心。[llama.cpp 多模态说明](https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md)支持模型与 mmproj 配对，并提供兼容接口。

## 远端真实调用

经当前 `VisionRouting` 与 Harness 调用远端服务，固定 PNG 输入、禁用 CUA 工具。每个样例一次未命中调用，再在同一 turn 内请求相同图片验证缓存。

| 固定截图 | 首次调用 | 相同图片复用 | 核对的目标文字 |
| --- | ---: | ---: | --- |
| 记事本 | 9.79 秒 | 0.26 毫秒 | 旧客户名、海风科技 |
| 计算器 | 17.68 秒 | 0.54 毫秒 | 37、24、888 |
| 客户表单 | 8.58 秒 | 0.24 毫秒 | 公司、工作邮箱、账单邮箱、备注的预期值 |

三张图片均返回目标文字，三次相同图片调用均复用结果。以上是小样本关键字段核对，**不是整体识图准确率 100%**；输出仍有冗余描述和未经图像直接证明的推断，例如“替换尚未执行”，不能将其当作操作完成事实。这是固定截图的模型集成验证，**不是重新跑过三个桌面任务，也不是最终 Windows 全量验收**。缓存时间不包括重新截图及主模型判断。

远端 `/v1/models` 返回 CUA 模型、vLLM、65,536 上下文及服务路径 `CUA-S1-Qwen3.5-4B-W8A16`。用户确认该远端部署来自指定模型。接口未提供权重哈希，因此不能将远端 W8A16 与本地 GGUF Q4 称为相同量化文件，也不能直接借用远端结果证明本地质量。

## 验证与产物

Node 24 执行以下目标，退出码 0，39 项通过：

```text
node --test runtime/tests/distribution-model.test.mjs runtime/tests/vision-routing.test.mjs runtime/tests/vision-routing-harness.test.mjs runtime/tests/vision-routing-acp.test.mjs runtime/harness/test/mcp-vision.test.mjs
node .local/cua-local-20261117/verify-api.mjs
```

第二条命令退出码 0，保存三次真实调用。日志和复现脚本位于 `D:\CodeBuddy-v1\.local\cua-local-20261117\`：`remote-api-result.json`、`remote-api.log`、`routing-tests.log`、`ollama-discovery.log`、`verify-api.mjs`。本地测试目录不提交。产品部署配置原本已满足 API 路径，本次未重复增加提供商或强制覆盖用户配置。
