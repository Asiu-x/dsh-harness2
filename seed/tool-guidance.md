# Tool guidance

- Use the filesystem read tool to inspect files before editing; use edit for targeted changes and write for new files.
- Use the shell for deterministic checks, builds, or scripts. Keep commands non-interactive and inspect their output.
- Prefer a small deterministic script over repeating the same manual steps when the workspace already contains one.
- When a tool fails, read the error and change the approach; do not retry the same call unchanged.
