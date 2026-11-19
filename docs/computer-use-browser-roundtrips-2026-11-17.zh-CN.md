# 减少主模型重复观察：浏览器实测

2026-11-17

[简体中文](computer-use-browser-roundtrips-2026-11-17.zh-CN.md) · [繁體中文](computer-use-browser-roundtrips-2026-11-17.zh-TW.md) · [English](computer-use-browser-roundtrips-2026-11-17.en.md)

主模型保持 deepseek-v4.1-flash:1017，思考强度保持 max（极致）。CUA-S1-Qwen3.5-4B 仍只识图。本轮只修改浏览器观察与工具说明，未修改模型选择、推理强度或视觉路由。

| Task | Before / s | After / s | Reduction | Passed |
| --- | ---: | ---: | ---: | --- |
| form | 27.660 | 19.007 | 31.3% | 3/3 → 3/3 |
| search | 31.376 | 18.627 | 40.6% | 3/3 → 3/3 |

![Comparison](../.local/browser-roundtrips-20261117/浏览器优化前后对比.png)

六轮单独 observe 调用从 16 降至 0，console 从 1 降至 0。最终每轮均为四次工具调用、五次任务模型请求，工具错误与 CUA 调用均为零。任务模型平均耗时为表单 14.67 秒、搜索 14.05 秒，仍是实测主要耗时。

打开页面直接返回紧凑控件、候选和文字引用；省去打开之后单独观察和补登记文字的往返。显式 observe 默认仍返回页面正文，可用 view=controls 取紧凑控件。文字引用在同页观察之间保留，空数组显式清除，导航自动清除。

动作后读取真实控件，并以约 80 ms 间隔检查变化；连续约 240 ms 不变或轮询预算约 800 ms 时返回。异步搜索建议可直接用于下一步。单次读取和调度耗时不计入硬超时保证，安静间隔也不表示业务完成；未出现的结果仍应继续观察。

主模型依据动作回执的最新值判断任务是否完成；verified:false 只表示宿主不代替模型判断完成。缺信息才继续观察，不要求固定的最终截图、观察或控制台检查。保留候选失效、遮挡、焦点变化和不确定写入的防重复执行边界。

开发阶段两轮表单分别为 21.172 / 22.206 秒，均正确，但各有一次遗漏标签页 ID 的拒绝调用。已将标签页 ID 前置，工具说明明确每个候选动作同时传 id、observationId、candidateId。开发证据保留，不混入下面最终同版的六轮统计。

基线取上一批最终版本的六轮真实产品任务，不是更早、更慢的初版。本版重新启动后，各用新会话执行同一表单和同一搜索提示词三次，顺序运行；表单只变化 N1/N2/N3 轮次标签。页面及其 160 ms 异步搜索延迟不变。

正确率按实际结果检查：表单两目标值、保留账单邮箱和备注、提交次数 0；搜索查询为海风、选择海风测试、未选海风账单、已选客户实际值正确。最终六轮均有独立 Windows 可见控件读回，不能以 Agent 自述替代结果。

计时为 Harness turn/start 至 turn/end，包含主模型、工具及错误恢复；不含会话创建、发送前等待与独立验收。界面计时可能更长。前后并非随机交错测试，网络、远端模型负载、缓存和模型选择路径有波动；三次均值不是普适性能保证。任务正确率也不代表通用视觉识别准确率。

自动检查：Vitest 浏览器控制 16/16、运行时 browser-tool 5/5、TypeScript --noEmit、真实 Electron 浏览器集成 1/1，退出码均 0。最后仅调整回执属性顺序与工具文案，运行时 5/5 再次通过；最终六轮产品验收在该调整重启后执行。未运行安装包、Mac 或未受影响的原生应用全套验收。

源码与交付：D:\CodeBuddy-v1，main，revision 如下，包含本次及原有未提交改动。未新建分支、未提交、未推送、未打包。通过仓库 .\start-preview.ps1 构建并启动。

| Phase / task | Session | Seconds | Tools | Main requests | CUA | Errors |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| after / form | `c7387663-9bbe-441b-a421-5a06d98e2702` | 17.500 | 4 | 5 | 0 | 0 |
| after / form | `f651375d-46f1-4cea-b2ec-dac59d0a562a` | 19.765 | 4 | 5 | 0 | 0 |
| after / form | `819dd277-d858-44a4-9a40-1486587f1188` | 19.755 | 4 | 5 | 0 | 0 |
| before / form | `463855e6-ac1d-43df-9760-c0db9f17aca3` | 27.193 | 6 | 7 | 0 | 0 |
| before / form | `2d350f7d-c80f-42ce-bb7b-bb1f9d4572df` | 34.292 | 7 | 8 | 0 | 0 |
| before / form | `d1dc9982-5118-4a63-bbb3-71a2d55c6a16` | 21.496 | 5 | 6 | 0 | 0 |
| after / search | `c748fe22-c875-4d06-9746-0784e44f680f` | 15.805 | 4 | 5 | 0 | 0 |
| after / search | `22bc5d3f-25c7-47fd-adac-b3001b47ac6c` | 20.728 | 4 | 5 | 0 | 0 |
| after / search | `98fbce58-bd9e-430a-9541-98cb928d329f` | 19.347 | 4 | 5 | 0 | 0 |
| before / search | `a094730b-de7d-4d87-a25b-a6377c6c4ca2` | 32.291 | 9 | 10 | 0 | 0 |
| before / search | `0c60ccc5-d576-4ff9-a0c1-ca8f768bcec1` | 29.510 | 8 | 8 | 0 | 0 |
| before / search | `813540ca-7b4d-426f-a35b-9ef60207f7b3` | 32.328 | 7 | 8 | 0 | 0 |

主模型请求数排除明确标记为 session-title 的自动标题调用；任务判断全程为 max。自动标题沿用原有 off 设置，可与任务并行，其时间另存。此口径修正上一份报告混合计数，端到端耗时不变。

```json
{
  "revision": "4c8afad978b6e893a3545c0859dd5b4824a91223",
  "electron": {
    "sourceHash": "063A7948F121E9476A201DCC2D8269B87E4FF0503D0347E675630B4A8F75C053",
    "started": "2026-11-17T22:45:02.0319770+08:00",
    "bundleWritten": "2026-11-17T22:45:01.9978947+08:00",
    "revision": "4c8afad978b6e893a3545c0859dd5b4824a91223",
    "electronPid": 44888,
    "bundleHash": "A0A2B56597446D12A5E002584E590F6C6B9ECBD7C4367D5A9154DAA3571219E0"
  },
  "runtime": {
    "pid": 48300,
    "startedAt": "2026-11-17T14:44:47.645Z",
    "sourceHash": "c99fce2a15e62318651d11d680dc04afae4bcc97f44457ea3f17fe18c51c4d49",
    "currentHash": "c99fce2a15e62318651d11d680dc04afae4bcc97f44457ea3f17fe18c51c4d49",
    "restartRequired": false
  }
}
```

Changed files:

- `runtime/browser-tool.mjs` + `runtime/tests/browser-tool.test.mjs`
- `ui/desktop/src/workspace-panel/browserControl.ts` + `.test.ts`
- `ui/desktop/src/workspace-panel/workspacePanelMain.ts`
- `ui/desktop/tests/e2e/workspace-browser.electron.spec.ts`

Commands (existing Node 24 runtime, cwd `ui/desktop` except runtime tests):

```powershell
node ../node_modules/vitest/vitest.mjs run src/workspace-panel/browserControl.test.ts
node ../node_modules/typescript/bin/tsc --noEmit
node ../node_modules/@playwright/test/cli.js test tests/e2e/workspace-browser.electron.spec.ts --reporter=list
node --test runtime/tests/browser-tool.test.mjs
```

[Raw data](../.local/browser-roundtrips-20261117/comparison-data.json) · [Source identity](../.local/browser-roundtrips-20261117/loaded-identity.json) · [Independent readback validation](../.local/browser-roundtrips-20261117/visible-check.py)

Local evidence: `.local/browser-roundtrips-20261117/` contains session exports, model timings, visible readbacks, runtime logs and reproducible chart/report scripts. Previous baseline evidence remains in `.local/browser-observation-20261117/`.

Design reference: [Playwright actionability](https://playwright.dev/docs/actionability) and [retrying assertions](https://playwright.dev/docs/test-assertions) motivate read-before-next-step checks. This bounded accessibility settling mechanism is project-specific and does not replace an explicit outcome assertion. No external code or dependency was imported.
