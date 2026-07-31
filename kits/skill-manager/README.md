# Skill Manager

Skill Manager is a Harbors Kit for inspecting and managing the global Codex Skill directory. By default it opens the global installation at `$CODEX_HOME/skills` (or `~/.codex/skills`); an optional source directory can be selected for comparison during the current session.

The manager will support recoverable install, update, disable, restore, and uninstall operations. System Skills under `.system` remain read-only, and the renderer never receives or submits raw filesystem paths.

## Development

```bash
npm run build -w @itharbors/kit-skill-manager
npm run test -w @itharbors/kit-skill-manager
```
