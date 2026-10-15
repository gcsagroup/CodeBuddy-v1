# Ollama Cloud G0/G1 资格验证 v2

v1 已保留两份真实失败记录：模型都能找到错误，但在没有带行号证据时偶发误报行号。v2 只增加一条要求：最终回答前必须用只读的带行号命令确认目标文件。其他 fixture、次数、超时、预期文件和零修改阈值均保持不变。

## 通过规则

- G0：固定提示连续 3 次在 120 秒内返回严格 JSON，必须 3/3 通过。
- G1：只有 G0 通过后才运行；固定只读 fixture 连续 3 次在 180 秒内准确报告 `src/pricing.py:3`，相同参数的工具调用不得连续超过 2 次，执行前后 Git tree 必须一致且工作区为空，必须 3/3 通过。
- 任意一次失败即停止该模型当前 Gate，记录 `FAIL`；不得把失败结果覆盖成通过。

## 执行命令

先在 CodeBuddy 中保存 Ollama Cloud 凭据并构建 release 后端，再从仓库根目录运行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\test-ollama-cloud-qualification.ps1 `
  -Model "glm-5.2" `
  -GooseBinary .\target\release\goose.exe
```

脚本不接收 API Key；它只从 Windows 系统凭据库读取现有配置，并且只把脱敏 fixture
复制到随机临时目录。模型 ID 会经过格式校验，结果文件已存在时脚本拒绝覆盖。

结果文件只记录模型 ID、版本、哈希、耗时、Token、工具调用摘要和判定，严禁记录 API Key 或 Authorization 内容。
