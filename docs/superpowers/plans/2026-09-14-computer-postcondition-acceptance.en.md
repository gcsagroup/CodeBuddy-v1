# Computer action postcondition acceptance

Date: 2026-09-14. [Traditional Chinese](2026-09-14-computer-postcondition-acceptance.md) is the default; [Simplified Chinese](2026-09-14-computer-postcondition-acceptance.zh-CN.md) is also available.

## Conclusion

The previous unknown reflects an insufficient acceptance expectation, not a confirmed product misclassification. Its only expectation was foreground:true, already satisfied before the click. A changed page does not establish that this condition was caused by the action. No product code or success threshold changed; original evidence remains preserved.

Real ACP computer tools clicked History in isolated Electron window 83169794 (PID 19340), using the observed exact visible button name “导入链接” as the postcondition. A newly appearing target returned worked; a preexisting target without attributable change returned unknown; a nonexistent button returned unknown with a timeout reason. Independent native window trees verified the page.

After 44.279 seconds, the old observation was rejected before input. Refreshing observation removed the expired screenshot identifier, which remained unusable. These are expected safeguards, not failed tests.

## Evidence and limits

Evidence root: .cargo/evidence/audit-fixes-20260914/. computer-postcondition-native-summary.json references calls 09, 16, 20, 24, 28, and 31. The computer-\*-native.txt files preserve independent observations. Existing computer module tests passed: 126 passed, 0 failed, 0 ignored. Exact command and exit code are in computer-postcondition-tests.json.

This verifies a specific page transition. Successful dispatch is distinct from verified action outcome and overall task completion. No model prompt was sent and neither 120 nor 107 was probed. Autonomous model acceptance remains pending. Mouse constraints, repeated failures, and resumable waits remain under audit.
