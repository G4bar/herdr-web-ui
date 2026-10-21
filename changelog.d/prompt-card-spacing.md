### Changed
- The `ask_user_question` card is spaced and proportioned on its own column: its text starts where
  the message box's does, its option rows reach the card's edge so the checkbox, the number and the
  label line up on one centre line, and its header is one line of text with the fold button over
  the padding. It sits 12px (8px with the keyboard up) above what comes next instead of touching it.
- Submit is right-aligned on the card's bottom edge and stays there while a long card scrolls,
  instead of scrolling out of reach at the bottom left.

### Fixed
- A picked option's description and number keep at least 4.5:1 against the tint (they were dim text
  and an accent number, under it in several palettes), and a keyboard-focused option row shows the
  accent ring instead of the background alone.
- The quick replies are hidden while the message box answers the card: a chip sent "continue" or
  "yes" through the same path as a number typed for the question, one tap away from the real
  choices. They come back when the card goes.
