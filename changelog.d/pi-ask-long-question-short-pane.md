### Fixed
- A pi `ask_user_question` card shows a long question whole, and keeps its options' previews: a
  narrow pane wraps the question inside words and rpiv cuts what it draws, so the card takes the
  text and the previews from the session's `ask_user_question` call instead of the screen's
  broken copy.
- The card now appears when the form is taller than the visible pane (a 26-row chat pane) instead
  of not appearing at all: the question, every option and its preview come from the session's
  call, and a multiple choice's `Submit` row is still sent where the pane cut it off. A multiple
  choice whose rows are off the pane stays terminal text, since which of them are ticked is not
  on the screen.
