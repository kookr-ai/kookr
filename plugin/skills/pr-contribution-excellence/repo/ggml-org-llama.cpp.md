# ggml-org/llama.cpp — PR Contribution Patterns

Distilled from analyzing 10 closed PRs (6 merged, 4 closed-without-merge) across multiple modules: gguf-py, ggml-cpu, console, unicode, server, webui, SYCL, ggml core, llama-arch.

## Key People

| Person | Role | Notes |
|--------|------|-------|
| **ggerganov** | Project founder, MEMBER | Reviews inline, pushes cleanup commits directly, changes his mind based on evidence |
| **CISC** | MEMBER | Fast first-responder (<15 min), does post-merge root-cause analysis, catches architectural misplacements |
| **ngxson** | Core contributor | Final merge authority after ggerganov approves, weighs in on test methodology |
| **pwilkin** | MEMBER | Approves, sometimes merges |
| **arthw** | SYCL module maintainer | Hardware-owner reviewer for Intel GPU PRs |
| **allozaur** | WebUI maintainer-delegate | Active in webui module, moves fast — will supersede stale PRs |
| **ggml-gh-bot** | Bot | Flags AI content within minutes, enforces "1 open PR for new contributors" rule |

## PR Velocity Expectations

| Outcome | Typical timeline |
|---------|-----------------|
| Trivial fix, correct | Merged in <24 hours |
| Performance PR with benchmarks | Merged in 12-24 hours |
| Feature PR with evidence | Merged in 5-9 days |
| PR needing rework | Closed in hours if author is responsive; stales in days if not |
| Silence after reviewer feedback | Superseded within 1-4 weeks |

## Module-Specific Conventions

### WebUI (`tools/server/`)
- **Mandatory build artifact**: Always run `npm run build` and commit `tools/server/public/index.html.gz` alongside source changes
- **WebUI Checks CI**: Marked `continue-on-error: true` but treated as a hard gate by maintainers for webui PRs
- **Test tiers**: `test:client`, `test:unit`, `test:ui`, `test:e2e` via Playwright
- **Active maintainer**: allozaur moves fast — search their open PRs before opening yours

### SYCL/Vulkan/Metal (hardware backends)
- **No automated CI**: Hardware-specific backends don't run in GitHub Actions CI
- **Hardware reviewer = CI**: Get someone with target hardware to reproduce your numbers
- **Module prefix**: Use `[SYCL]`, `[Vulkan]`, `[Metal]` in PR title

### ggml-cpu (SIMD kernels)
- **Arch-specific files**: SIMD kernels go in `ggml/src/ggml-cpu/arch/{arch}/quants.c`, NOT in generic `quants.c`
- **Check for existing helpers**: Functions like `hsum_float_8`, `bytes_from_bits_32`, `mul_sum_i8_pairs_float` already exist in arch files
- **Recent restructuring**: File organization changed — always check `git log` for where code lives now

### Quantization types
- **Naming**: `QX_0` (single scale), `QX_1` (scale+bias), `QX_K` (superblocks). Non-standard names rejected immediately
- **Enum values**: Must be sequential, no gaps. Removing a type requires updating the slot
- **CPU-only first**: New quant types should be CPU-only initially. GPU backends in follow-up PRs
- **Correctness proof**: `llama-perplexity --kl-divergence` against FP16 reference is expected
- **Deployed models required**: "Our models use this format" (with HuggingFace links) is what unlocks review
- **Backend stubs**: Always update `arch-fallback.h` — exercised by WebAssembly/non-NEON targets

### Server
- **Debug tags over log strings**: Use `SLT_DBG`/`SRV_DBG` for test-readable signals, not log message matching
- **Logging macros**: `SRV_WRN`, `SLT_DBG` — match existing conventions
- **Windows CI**: Must pass. Temp file cleanup with `os.unlink()` breaks on Windows

### Architecture registry (`llama-arch.cpp`)
- **Facts only**: Arch files define model structure facts. Don't add fake entries to suppress behavioral bugs
- **Root-cause in behavior files**: If a warning comes from `llama-quant.cpp`, fix it there, not in the arch registry

## Non-Negotiable Rules (llama.cpp-specific)

| # | Rule | Evidence |
|---|------|----------|
| 1 | **Validate fix against ground truth before submitting** | #21219: 30-second `gguf_dump` check would have prevented wrong-file fix |
| 2 | **Trace warnings to their emission site** | #21219: Warning from `llama-quant.cpp` was "fixed" by editing `llama-arch.cpp` |
| 3 | **Respond to reviewer feedback within days, not weeks** | #20238: 24-day silence → superseded; #21219: 6-day silence → stalled |
| 4 | **Bring quantified evidence, don't delegate validation** | #21451: "Someone please run systematic tests" → premise invalidated by maintainer |
| 5 | **Keep PRs to single concern, even drafts** | #21451: 18 files mixing CUDA + tokenizer + debug tools → abandoned |
| 6 | **Know the current file organization** | #21562: Code in generic `quants.c` instead of `arch/x86/quants.c` → rework |
| 7 | **Respect "1 open PR for new contributors" rule** | #21562: Bot enforces publicly |
| 8 | **Validate measurement methodology before proposing fix** | #21451: NMSE inflated by testing instruct models without chat template |
| 9 | **Include build artifact for webui changes** | #20238: Missing `index.html.gz` was first reviewer feedback, never addressed |
| 10 | **Extend patterns, don't reinvent** | #21527: Q8_0 following Q4_0/Q4_K/Q6_K pattern → 12h merge; #21257: Qwen2 handler following Llama3 handler → clean review |

## AI Disclosure Strategy

The project has explicit anti-AI-generated-content policy (`AGENTS.md` + `CONTRIBUTING.md`). However, merged PRs show a nuanced enforcement:

| Pattern | Outcome |
|---------|---------|
| "Used AI to discuss general solution" + human-verified code | Accepted (#21257) |
| "NEON paths generated with help of AI" + KL divergence proof | Accepted (#21273) |
| "AI assisted with root cause investigation" + real hardware testing | Accepted (#21527) |
| "Developed with assistance of Claude" + no evidence of human mastery | Not explicitly rejected but adds risk (#20238) |

**Rule**: AI disclosure is mandatory. Frame as "AI-assisted, human-verified" with specific evidence of what the human validated (benchmarks, hardware testing, KL divergence). The more quantitative the human verification, the less the AI disclosure matters.

## What Makes PRs Succeed

1. **Quantified evidence before asking for review**: Benchmarks (t/s, BW%), KL divergence, before/after terminal output
2. **Extending established patterns**: Copy existing handler structure, follow existing optimization pattern
3. **Responsive iteration**: Same-day responses to reviewer feedback; accept structural suggestions without resistance
4. **Correct module placement**: Know where code lives after recent restructurings
5. **Single clean commit on first push**: Subject + body explaining non-obvious aspects, `Fixes: #NNN` trailer
6. **Proactive AI disclosure**: In PR body AND commit message, before bot flags it

## What Makes PRs Fail

1. **Wrong root cause**: Fixing symptoms in the wrong file instead of tracing to the emission site
2. **Missing evidence**: Delegating validation to the community instead of bringing proof
3. **Scope bloat**: Mixing multiple concerns in one PR, even as a draft
4. **Stale response**: Not responding to reviewer feedback for >1 week
5. **Missing conventions**: Build artifacts, arch-fallback stubs, enum gaps
6. **Wrong file location**: Not checking `git log` for recent file restructuring

## Collaborative Culture Notes

- **Reviewers push fixup commits directly** to PR branches. This is collaborative ownership, not criticism. Welcome it.
- **TODO comments get removed** by reviewers. Propose systemic improvements in separate issues.
- **Maintainers reverse their own suggestions** when authors provide evidence of trade-offs (e.g., fast-tool-call case in #20993).
- **Post-merge follow-ups are normal**: Naming improvements, additional backends, etc. Don't block merge for perfection.
- **`[no ci]` in commit message** is accepted practice for comment-only changes.
