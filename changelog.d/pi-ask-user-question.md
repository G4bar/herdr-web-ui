### Added
- pi's `ask_user_question` questionnaire (the `@juicesharp/rpiv-ask-user-question` extension)
  is read off the terminal as an answerable card: its header, its numbered options with
  descriptions, a multiple choice's checkboxes, the free-text row, and the Submit tab with the
  answers it would send. A form of several questions is answered a tab at a time.
  `HERDR_WEB_PI_ASK_PROMPT=0` (plugin env file, then restart the plugin) leaves it as plain
  terminal text.
- A questionnaire the card cannot answer stays terminal text: a list with rows off the pane
  (`↓`/`↑` or `(n/total)`), a multiple choice whose `Submit` row is off it too, or a list whose
  numbering starts past 1. The card does not offer the dialog's `n` note line or `Ctrl+]`
  collapse either.
