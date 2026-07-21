# Installable notify-user Skill Implementation Plan

> **For Codex:** Use the executing-plans workflow to implement each task with focused verification.

**Goal:** Make the bundled `notify-user` Skill independently installable as a user-level Codex Skill and document a one-sentence installation flow.

**Architecture:** Keep `.agents/skills/notify-user` as the canonical distributable directory. The Skill resolves its own directory and invokes the bundled CLI by absolute path, while Harbors continues to own the loopback Host and Notification Center.

**Tech Stack:** Markdown Skill instructions, Node.js CLI/tests, Codex Skill metadata.

---

### Task 1: Specify and test working-directory independence

**Files:**
- Modify: `.agents/skills/notify-user/tests/notify.test.mjs`
- Modify: `.agents/skills/notify-user/SKILL.md`
- Modify: `.agents/skills/notify-user/agents/openai.yaml`

1. Add a test that copies the Skill to a temporary install directory, starts a mock Host, and executes the bundled CLI from an unrelated working directory.
2. Add static assertions that the Skill instructs Agents to resolve the loaded Skill directory and does not require the Harbors repository root.
3. Run the focused test and observe the static contract fail before editing the Skill.
4. Rewrite the Skill to use its own installation directory, preserve the success/failure contract, and clarify trigger and fallback rules.
5. Refresh UI metadata and run the focused test plus Skill validation.

### Task 2: Document installation and verify the distributable

**Files:**
- Modify: `readme.md`
- Modify: `docs/guides/developing-plugins-and-kits.md`

1. Document the canonical GitHub Skill directory, default user-level destination, and a copyable Codex installation prompt.
2. Update usage examples so installed Agents do not depend on a Harbors checkout.
3. Run focused tests, Skill validation, and the repository check suite.
4. Review the diff, commit the feature, push the existing feature branch, and verify the open pull request.
