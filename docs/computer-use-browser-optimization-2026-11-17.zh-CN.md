# 浏览器观察优化与验收

2026-11-17

[简体中文](computer-use-browser-optimization-2026-11-17.zh-CN.md) · [繁體中文](computer-use-browser-optimization-2026-11-17.zh-TW.md) · [English](computer-use-browser-optimization-2026-11-17.en.md)

## 结果

同一客户表单与动态搜索任务，前后各跑 3 次。主模型维持 deepseek-v4.1-flash:1017、极致思考；CUA-S1-Qwen3.5-4B 只识图、没有动作工具。最终 6 轮均通过检查，没有调用 CUA。

| 任务 | 优化前均值 | 优化后均值 | 耗时减少 | 任务正确率 |
| --- | ---: | ---: | ---: | --- |
| 表单 | 34.40 s | 27.66 s | 19.6% | 3/3 → 3/3 |
| 搜索 | 40.85 s | 31.38 s | 23.2% | 3/3 → 3/3 |

![Comparison](../.local/browser-observation-20261117/浏览器优化前后对比.png)

## 改动

1. 浏览器动作直接返回最新的精简控件状态和新候选，沿用已校验的原文引用。主模型可以直接执行下一步，减少单独 observe 往返；需要正文时仍可完整观察页面。
2. 保留无障碍节点父子关系，并明确聚合 status/alert 的实际文本。“已选客户”和同名建议按钮能够区分，控件可读的字段无需 OCR。
3. 浏览器相同截图复用上次已完成的识图结果，限定同轮、同会话、同标签页、同导航版本、同模型和完全相同图片哈希。图片、导航或目标变化及取消不复用无效结果；当前工具文本回执仍保留。
4. 内置 CUA 的直接读图配置覆盖浏览器截图，仅观察模型关闭思考且无动作工具。主模型思考强度和普通附件图片问答设置不变。
5. 输入参数错误先拒绝，不提前消费候选、不派发输入。真正派发结果不确定时仍消费候选；动作后读取失败保留真实派发事实，不自动重放输入。旧 node 调用保留此前完整观察过且仍存在的节点。

设计沿用现有 CDP 事实所有者，参考 [Playwright ARIA snapshots](https://playwright.dev/docs/aria-snapshots) 的层级结构观察方式，未复制外部实现或新增依赖。

## 构建与验证

- `D:/CodeBuddy-v1`, `main@4c8afad97` + dirty work; `./start-preview.ps1`.
- Runtime PID 28160, Electron PID 17324; started `2026-11-17T21:37:06.9688940+08:00`, bundle written `2026-11-17T21:37:06.9360807+08:00`.
- Runtime SHA256: `949630197931caf5a7a464c5125d5807b7f6c915ba6555ed5460265a30773d3e`.
- Controller SHA256: `12C5E376E02316C6273D24DC7A0FDE9D548049AACB355CA59FEA6238708F97DC`.
- Bundle SHA256: `273C03A705C277FFFD1AB5851CEE4909546CF7582F7AE1618645B83A91EFCF38`.
- 未创建分支、提交、推送、安装依赖或制作安装包；保留其他未提交修改。

| Command | Result / exit |
| --- | --- |
| `vitest run src/workspace-panel/browserControl.test.ts` | 13 PASS / 0 |
| `tsc --noEmit` | PASS / 0 |
| `node --test runtime/tests/vision-routing.test.mjs` (final cache-key regression) | 14 PASS / 0 |
| `playwright test tests/e2e/workspace-browser.electron.spec.ts --reporter=list` | 1 PASS, 13.7 s / 0 |
| `node --test runtime/tests/vision-routing.test.mjs runtime/tests/browser-tool.test.mjs runtime/tests/vision-routing-harness.test.mjs runtime/harness/test/mcp-vision.test.mjs` | 31 PASS / 0 |
| `node --test --test-name-pattern='host.*(capture identity\|image admission\|screenshot)' runtime/harness/test/capabilities.test.mjs` | 3 PASS / 0 |
| `node --test runtime/tests/browser-tool.test.mjs` (final description) | 4 PASS / 0 |

命令使用已有 Node 24 和 ui/node_modules 执行文件。初次 Vitest 路径误指 desktop/node_modules，改用已有工作区包后通过，没有安装依赖；第一次重启等待旧后端结束后才重试。

## 原始执行轮次

| Phase / task | Session | Seconds | Tools | Main requests | CUA |
| --- | --- | ---: | ---: | ---: | ---: |
| after / form | `463855e6-ac1d-43df-9760-c0db9f17aca3` | 27.193 | 6 | 8 | 0 |
| after / form | `2d350f7d-c80f-42ce-bb7b-bb1f9d4572df` | 34.292 | 7 | 9 | 0 |
| after / form | `d1dc9982-5118-4a63-bbb3-71a2d55c6a16` | 21.496 | 5 | 7 | 0 |
| before / form | `19af5992-cbfd-4f3b-8af5-a553ca04ba4a` | 35.231 | 8 | 9 | 0 |
| before / form | `e9b7de3a-33e4-40d8-9e8b-f684035be41a` | 37.881 | 7 | 9 | 0 |
| before / form | `7e0e0f2b-98ac-422e-98a8-0262657b0fcd` | 30.080 | 7 | 9 | 0 |
| after / search | `a094730b-de7d-4d87-a25b-a6377c6c4ca2` | 32.291 | 9 | 11 | 0 |
| after / search | `0c60ccc5-d576-4ff9-a0c1-ca8f768bcec1` | 29.510 | 8 | 8 | 0 |
| after / search | `813540ca-7b4d-426f-a35b-9ef60207f7b3` | 32.328 | 7 | 9 | 0 |
| before / search | `b852a055-c392-405d-8f49-ee8e5f9421d8` | 46.804 | 8 | 9 | 1 |
| before / search | `a75f0367-968a-44e5-a535-692c4ed896b5` | 43.319 | 9 | 10 | 0 |
| before / search | `070d3d63-260c-4634-bee9-ab13cdec1eec` | 32.437 | 7 | 8 | 0 |

## 缓存验证与限制

两次截图工具返回分别为 **6.967 秒、0.833 秒**，实际 CUA 推理 1 次（5.881 秒，0 个动作工具）。每次都重新调用 capturePage，复用的是已完成的识图文本，不能据主模型回复误称为跳过了第二次截图。

搜索的工具调用均值仍为 8 次，主模型请求 9 → 9.33 次；本批搜索提速主要来自省去 CUA，而不是减少了全部工具往返。表单的工具调用 7.33 → 6 次。最终主模型请求耗时均值约为表单 23.86 秒、搜索 25.64 秒，仍是主要耗时。基线采用本次优化前的候选接口版本，具体源码身份保存在 before-hashes.json。

- Cache session: `1c5db5d0-42af-4b0c-bb6b-94f47e2f6404`. Screenshot calls: 2; CUA sessions: 1; reused observations: 1.
- 开发轮次耗时 44.664 秒，曾出现两次参数／候选过期错误，恢复后填写正确。保留独立证据；该轮早于最终修复，不混入最终版本对照。
- 计时为 Harness turn/start 至 turn/end，包含模型与工具，不包含会话初始化与独立人工核对。顺序测试未随机交错，远端负载、缓存与模型波动仍影响比较。
- 表单检查两个目标字段、保留账单邮箱与备注、零提交；搜索检查查询、正确候选、未选账单候选及实际选中结果。最终每轮另有独立可见控件核对。基线搜索第 3 轮有动作与控件回执，但面板已收起，未保留独立页面核对。小样本任务成功率不等于通用视觉识别准确率。
- 主模型仍偶尔多做观察或控制台检查，剩余延迟已计入，未隐藏。识图缓存不能修正错误识别。本批未重跑 Mac、安装包及未变更的原生应用验收。

## 文件与证据

- `ui/desktop/src/workspace-panel/browserControl.ts` + `.test.ts`
- `ui/desktop/tests/e2e/workspace-browser.electron.spec.ts`
- `runtime/browser-tool.mjs`, `runtime/vision-routing.mjs`, `runtime/compat.mjs`, `runtime/harness/driver.mjs`
- `runtime/tests/vision-routing.test.mjs`, `runtime/harness/test/capabilities.test.mjs`
- [Data](../.local/browser-observation-20261117/comparison-data.json), [cache evidence](../.local/browser-observation-20261117/cache-validation.json), [source identity](../.local/browser-observation-20261117/loaded-identity.json).
- `.local/browser-observation-20261117/`: raw session exports, timings, visible control readbacks, runtime logs, chart and reproducible analysis scripts. Local evidence remains uncommitted.

[Final process/bundle check](../.local/browser-observation-20261117/final-identity-check.json) · [Runtime hash check](../.local/browser-observation-20261117/runtime-source-check.json) · [Verification summary](../.local/browser-observation-20261117/verification-summary.json)
