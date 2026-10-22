### Added
- pi's `ask_user_question` questionnaire (the `@juicesharp/rpiv-ask-user-question` extension)
  is read off the terminal as an answerable card: its header, its numbered options with
  descriptions, a multiple choice's checkboxes, the free-text row, and the Submit tab with the
  answers it would send. A form of several questions is answered a tab at a time.
  `OVIS_PI_ASK_PROMPT=0` (plugin env file, then restart the plugin) leaves it as plain
  terminal text.
- The card carries what the pane's screen never shows, joined from the session's
  `ask_user_question` call: the question's header in its heading, each option's `preview`
  (a single choice then picks a radio and waits for `Submit`, so a preview can be read before
  committing; a number typed in the message box picks the same way and the box says so), and the
  option the agent recommends, tagged without being pre-selected. Where
  the call cannot be matched to the screen (no session, another question, other labels, two
  open questions alike), the card stays exactly what the screen says and the answer keys never
  come from the session.
- A questionnaire the card cannot answer stays terminal text: a list with rows off the pane
  (`↓`/`↑` or `(n/total)`), a multiple choice whose `Submit` row is off it too, a list whose
  numbering starts past 1, or the `n` notes box while it is open. The card does not offer that
  note line or `Ctrl+]` collapse.
