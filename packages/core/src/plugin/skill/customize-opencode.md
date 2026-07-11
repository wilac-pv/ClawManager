# Customizing Ruying Code

Ruying Code validates its configuration strictly. Preserve existing fields and
comments, and do not invent undocumented settings. No public schema URL is
configured in the OEM build; use the installed source and local configuration
types as the authoritative reference.

## Configuration locations

- Project: `./ruying-code.json`, `./ruying-code.jsonc`, or files below `.ruying-code/`.
- Global: `~/.config/ruying-code/ruying-code.json` or `ruying-code.jsonc`.
- Compatibility-only legacy inputs may still be read from `opencode.json` and
  `.opencode/`; write new configuration to the branded locations.
- Project agents: `.ruying-code/agent/<name>.md` or `.ruying-code/agents/<name>.md`.
- Project commands: `.ruying-code/command/<name>.md` or `.ruying-code/commands/<name>.md`.
- Project skills: `.ruying-code/skill/<name>/SKILL.md` or `.ruying-code/skills/<name>/SKILL.md`.
- Global agents, commands, and skills use the equivalent folders below
  `~/.config/ruying-code/`.

Do not add a public `$schema` value. Public session sharing is disabled; keep
`"share": "disabled"`. The OEM provider is `ruying`, and users authenticate
with `ruying-code login`.

## Common shapes

```json
{
  "model": "ruying/model-id",
  "default_agent": "build",
  "share": "disabled",
  "enabled_providers": ["ruying"],
  "agent": {
    "reviewer": {
      "description": "Reviews changes",
      "mode": "subagent",
      "permission": { "edit": "deny" }
    }
  },
  "command": {
    "review": { "description": "Review changes", "template": "Review $ARGUMENTS" }
  },
  "mcp": {
    "local-tools": {
      "type": "local",
      "command": ["local-mcp-server"],
      "enabled": true
    }
  },
  "permission": {
    "edit": "ask",
    "bash": { "*": "ask", "git status": "allow" }
  }
}
```

Skill files are named `SKILL.md`, contain `name` and `description`
frontmatter, and live in a folder matching the skill name. MCP `command` is an
array. Plugin entries are strings, local file paths, or `[name, options]`
tuples. Permission rule insertion order matters because the last matching rule
wins.

After changing config-time files, tell the user to restart Ruying Code. For a
broken project config, start with `RUYING_CODE_DISABLE_PROJECT_CONFIG=1` when
supported by the installed version, or temporarily move the malformed file and
then repair it locally. Never fetch public OpenCode documentation or schemas.
