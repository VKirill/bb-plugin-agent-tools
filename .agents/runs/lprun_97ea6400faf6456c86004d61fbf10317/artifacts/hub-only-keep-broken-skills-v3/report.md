STATUS: complete

# Hub-only mode never archives a skill BB cannot load

incident: loop:topic:8d0f97f5fa64
hypothesis: the code change was right both times; attempt 1 failed only because the PM's /tmp check imported code from a hardcoded main-checkout path (now process.cwd()), and attempt 2 failed only in the test_fit gate because the old case in tests/hub-only.test.ts encodes the wrong behaviour being removed (machine a with a blocking-rejected skill expected to be cleaned) and the contract did not list the file in test_removals. This try lists it in test_removals and puts all new cases in a new file tests/hub-only-broken.test.ts.

On 2026-11-06 the hub-only mode archived 5 skills from the Mac mini that BB could not load from the hub (broken frontmatter YAML on the hub copies), so they vanished from every session. Count only loadable hub skills as present, and never clean a machine while it holds a skill BB refuses.

Attempt 1 accepted by Lane Pilot BB writer.
