# First-response optimization: session and run snapshots

Source: existing D:\CodeBuddy-v1, no .git, branch, commit or push. Candidate 1.43.3-harness4. Model, thinking effort, 55 tools and frontend interactions remain unchanged. Harness owns execution, completion and compaction.

A real isolated greeting recorded 21 store reads totaling 1127ms. Some callers needed only the current session or runs but cloned all history. The store now selects a session before cloning in readSession; compat, conversation-driver and transcripts use it. CodePro queries request only codeproRuns. Writes, permissions, persistence and recovery semantics are unchanged.

Three alternating groups on the same data, each performing 20 session/run reads: old 2624/3105/2874ms, new 29/20/35ms. This is a local benchmark, not end-to-end improvement. Real request first text changed from 20.738 to 9.003s, but module/OS caches and network varied; that entire difference is not attributed to this patch.

Related tests passed 23/23 plus 43/43, exit 0: snapshot isolation, committed updates, deletion, native Harness tools, transcripts, concurrency and recovery. Exact commands and files are in the [Chinese record](2026-10-15-response-latency.zh-CN.md). Evidence: latency-snapshot-benchmark.json, adapter-profile-before/after.log, latency-snapshot-tests.log, latency-adapter-regression.log.

Harness4 build and installation exited 0 using existing Node 24 and the documented entry. Installed acceptance exposed differing directory/file real paths in the Windows app container, causing tool identity rejection. It is not an accepted candidate. Anchoring resources to the physical manifest fixed the service regression (3/3, typecheck and lint passed). Harness5 was superseded during build when the capacity defect emerged; both fixes now target harness6.

The user switched to Gemma and expanded the catalog to 205 tools; these results are not directly comparable to the earlier Kimi timings. Harness4 cold/warm samples displayed text at 9.38/4.86s but produced only one token and stopped with max_tokens: both are interrupted, not successful greetings. See the [model capacity record](2026-10-15-context-capacity.en.md). The previous accepted installer remains under target/accepted-harness-installer-1.43.3-harness3.
