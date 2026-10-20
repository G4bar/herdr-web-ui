### Added
- Chat lists the commands and skills an OpenCode v2 pane's own background service reports for its
  folder, refreshed when they change, and settles a command it sent from that session's own events.
  The service is only read, never started, and only when it is the process its service.json names.
- An `@skill` sent from Chat to OpenCode v2, at once or queued, is typed through OpenCode's own
  autocomplete so the skill is attached; when the row does not show, the message says the skill
  went as plain text and points to the terminal.
- An OpenCode 1.x question is a card in Chat with each option and its description, answered from
  the card.
- Chat lists a Codex pane's skills as its running Codex daemon reports them (Codex 0.157 or later,
  not on Windows), and a gjc pane's skills as the SDK broker it is bound to reports them. Neither is
  ever started for this; without one, the skills read from disk stay.
