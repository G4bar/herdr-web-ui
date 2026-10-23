### Added
- A Pi pane can be driven from the chat itself: its More menu's **Take over in chat** quits Pi in the
  pane and the bridge runs that session through Pi's own RPC mode, so a message becomes a prompt
  instead of keystrokes, and Pi's model, thinking level, queue and stats arrive as they change
  rather than being read off the screen. Only one writer holds a session file, so take-over needs an
  idle Pi pane and refuses a busy one; a folder Pi has not been trusted for gets the trust card
  below. **Open in terminal** starts Pi in the pane again on the same session, and a bridge that
  restarts leaves its panes **Lost** with **Reconnect**, which resumes the same session file (a turn
  in flight is lost with it).
- A native Pi's model and thinking level sit beside the message box as chips that open a picker:
  models grouped by provider with a search, thinking levels high to low, and **Save as default** in
  either. A Terminal-mode Pi pane shows the two chips read-only when its session names them.
- While Pi works, the box says what Enter does: **Steer** (the default) or **Follow up**, and
  Alt+Enter always follows up. Messages waiting on Pi are listed by kind, each with **Restore** and
  **Remove**, plus **Restore all** and a two-step **Clear queue**; Stop puts the cleared messages
  back in the box and says how many.
- Pi's dialogs are answered in the chat instead of the pane: a select, a confirm and an input or
  editor field arrive as the question card, with the focused option's preview beside the rows, a
  countdown when Pi sets a deadline, and its prefill in the editor. A folder Pi would ask about
  before it loads what can run code in it gets the trust card: what it found, with **View**,
  **Don't trust** and **Trust folder**. The answer holds for that run alone; Pi's own trust record
  is never written.
- Tool rows read as Pi's verbs, and an opened card is the thing the call touched: a bash command
  with its output, exit code and a cut output that opens whole, a read's file chip and lines, a
  write's first lines, an edit's diff, an `ask_user_question`'s picked answers and preview, a
  codemode script with the calls it made, and an MCP call's input and output. A running call shows
  its last lines as they arrive, with Stop. **Show thinking** and **Expand tool output** switch the
  thinking blocks and every card body, and the thinking row carries the turn's level.
- The context ring opens a popover with the window in use, tokens, cache, cost (or a
  **Subscription** pill), compactions, Pi's status lines and **Compact now** with instructions. A
  retry says why and offers **Cancel retry**; a compaction says it is running.
- Typing `!` (or `!!`) in a native Pi's box runs the rest as a shell command through Pi, in the
  transcript and with a live tail, and Esc stops it; `!!` keeps the command and its output out of
  what Pi reads.
- Pi's keys work in the message box, read from your `~/.pi/agent/keybindings.json` over Pi's
  defaults: Ctrl+L model, Ctrl+P next model, Ctrl+T thinking blocks, Shift+Tab thinking, Ctrl+O
  tool output, Alt+Enter follow up, Alt+Up restore the queue, and Ctrl+C clears an empty box. The
  shortcut list has a Pi group naming the file it read. Pi's own commands are the chat's surfaces:
  `/model`, `/new`, `/name`, `/compact`, `/session`, `/export`, `/copy`, `/tree`, `/fork`,
  `/context`, `/settings`, `/scoped-models` and `/hotkeys`; `/login` and `/logout` open the
  terminal, which needs Pi's own screen.
- **Settings → Pi** holds a Pi's default model and thinking level, its scoped models, how a steering
  and a follow-up message are delivered, automatic compaction and retry, and the **Pi keys in the
  message box** switch. It writes only those keys of `~/.pi/agent/settings.json`, leaves everything
  else in the file as it was, and refuses (409) a file it cannot read as JSON. Session rows are
  disabled for a terminal-mode pane.
- **Scoped models** picks which models Pi cycles: grouped by provider, with provider toggles,
  reordering, Enable all and Clear all; the model picker then offers **Scoped** and **All**.
- **Session tree** (`/tree`, or Esc Esc on an empty box) walks a session's branches with filters for
  user messages, labels, tools and timestamps, and forks from a message you sent, putting the fork's
  text in the box behind a quiet row with **Go back**. **Fork from here** on one of your own
  messages does the same from the transcript, and **Clone session** copies the whole session.
- **Earlier sessions** in a native Pi lists that folder's Pi sessions and opens one with Pi's own
  switch instead of a new tab, filters to named ones, shows the path, sorts by recency or match,
  renames the current session, and deletes another in two steps, though not the session a pane is
  running.
- **Session context** lists what Pi loaded for the pane's folder: its context files (global,
  project and parent folders), skills, prompt templates and extensions, with a skill or prompt
  inserting its command into the box and **Reload** asking Pi to load them again. An empty native
  chat says how many of each it found and opens the same dialog; a terminal-mode pane gets the
  context files.
- Rows Pi pushes into a native chat's own surfaces are drawn there: a `notify` line as a quiet row
  at the end of the transcript (they last for the session and go on reload, since the session file
  does not hold them), an extension's `custom` message with its own label and rail, a widget above
  or below the box as a plain card of up to six lines, and text Pi sets in the box once.

### Fixed
- Warning text is readable again in light Tokyo Night Day, Gruvbox Light, One Light, Solarized
  Light, Kanagawa Lotus and Rose Pine Dawn, and in dark Solarized: those palettes' `--notice`, which
  draws Pi's warning rows, the context ring past 80% and the composer's notices, now passes AA.
