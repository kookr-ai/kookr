# Onboarding Smoke Test

You are testing whether a new developer can set up the "kookr" project by following only its README.md. You have access to a clean Ubuntu 24.04 machine via `docker exec`.

## How to run commands

Run all setup commands inside the container using the Bash tool:

```
docker exec -u developer -w /home/developer/kookr CONTAINER_NAME bash -c '<command>'
```

Replace CONTAINER_NAME with the actual container name provided at the end of this prompt.

For commands that need root (e.g., apt install), prefix with sudo inside the bash -c:

```
docker exec -u developer -w /home/developer/kookr CONTAINER_NAME bash -c 'sudo apt-get update && sudo apt-get install -y <package>'
```

For long-running commands (servers), use background execution and then verify:

```
docker exec -d -u developer -w /home/developer/kookr CONTAINER_NAME bash -c '<command>'
```

## Rules

1. First, read the README from inside the container:
   `docker exec CONTAINER_NAME cat /home/developer/kookr/README.md`
2. Follow the setup instructions **exactly as written in the README**. Do not use any knowledge beyond what the README provides. Pretend you have never seen this project before.
3. If a prerequisite is listed but no install instructions are given, that's a gap. Note it, then install the prerequisite yourself using standard Ubuntu methods to continue the test.
4. If a step is ambiguous or missing, note the gap but try your best to proceed using reasonable assumptions a new developer might make.
5. After setup, verify the application works:
   - The health endpoint responds with HTTP 200
   - The frontend serves HTML content
6. Write the report using the Write tool to the report path provided at the end of this prompt.

## Report format

**CRITICAL:** Write the report as if the user is on a regular Ubuntu computer. Translate all `docker exec ... bash -c '<cmd>'` into just the inner `<cmd>`. Do not mention Docker, containers, exec, or images anywhere in the report. The report should read as a first-person walkthrough: "I ran `pnpm install` and it succeeded."

Use this exact structure:

```
# Onboarding Smoke Test Report

**Date:** YYYY-MM-DD
**README version:** (git SHA from git rev-parse HEAD)
**Verdict:** PASS | FAIL

## Prerequisites

| Prerequisite | Documented in README? | Install instructions provided? | Notes |
|---|---|---|---|
| Node.js | yes/no | yes/no | ... |
| pnpm | yes/no | yes/no | ... |
| tmux | yes/no | yes/no | ... |
| (any others discovered) | ... | ... | ... |

## Setup Steps

### Step N: <description>
- **Command:** `<what the README said to run>`
- **Result:** SUCCESS | FAILURE
- **Output:** (key output or error, truncated to ~5 lines)
- **Issue:** (if any — missing docs, unclear instruction, implicit assumption)

## Verification

| Check | Result | Notes |
|---|---|---|
| Health endpoint returns 200 | PASS/FAIL | ... |
| Frontend serves HTML | PASS/FAIL | ... |
| No errors in server output | PASS/FAIL | ... |

## Gaps Found

1. (list each missing or unclear instruction)
2. (list each implicit assumption the README makes)

## Recommendations

1. (specific, actionable suggestions to improve the README)
```

The verdict is **PASS** only if a new user could complete setup and verification without any external knowledge (no Googling, no guessing). Any gap that requires knowledge not in the README = **FAIL**.
