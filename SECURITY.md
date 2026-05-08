# Security Policy

## Supported Versions

Kookr receives security fixes on the latest tagged release and on the `main`
branch. Older tags are not supported unless the maintainer explicitly says
otherwise in a release note.

| Version | Supported |
| --- | --- |
| Latest tagged release | Yes |
| `main` branch | Yes |
| Older releases | No |

## Reporting a Vulnerability

Please report suspected vulnerabilities privately through GitHub Private
Vulnerability Reporting:

https://github.com/kookr-ai/kookr/security/advisories/new

Do not open a public issue for a suspected vulnerability. If the private
reporting link is unavailable, email the maintainer address listed on the
repository owner's GitHub profile with a concise subject such as
`Kookr security report`.

Helpful reports include:

- Affected Kookr version, commit, or branch.
- A clear description of the vulnerability and expected impact.
- Reproduction steps, proof of concept code, logs, or screenshots when safe to
  share privately.
- Any relevant environment details, such as operating system, Node.js version,
  enabled integrations, and whether permission bypass mode was enabled.

Please avoid accessing, modifying, or exfiltrating data that is not yours. Keep
testing limited to your own local Kookr instance or an environment where you
have explicit permission.

## Response Expectations

The maintainer aims to acknowledge new private reports within 7 days. After
acknowledgement, the maintainer will triage the report, ask for any missing
reproduction details, and share an expected remediation path when the issue is
confirmed.

Fix timelines depend on severity and exploitability, but confirmed high-impact
issues will be prioritized over regular feature work. Public disclosure should
wait until a fix or mitigation is available unless there is active exploitation
or another compelling safety reason to disclose earlier.

## Scope

Security-sensitive areas include, but are not limited to:

- Agent subprocess launch and permission-bypass handling.
- WebSocket terminal bridging to local dtach sessions.
- Local task state and hook logs under `~/.kookr/`.
- Optional integrations that use secrets from `.env`, including Telegram,
  speech services, and third-party LLM APIs.

Out of scope:

- Vulnerabilities in third-party dependencies that are not exploitable through
  Kookr. Please report those upstream.
- Reports that require physical access to the user's machine or full control of
  the user's account.
- Social engineering, phishing, or attacks against GitHub, npm, cloud
  providers, or other services outside this repository.
- Denial-of-service reports based only on exhausting local CPU, memory, disk, or
  API quota without a Kookr-specific amplification or privilege boundary issue.
