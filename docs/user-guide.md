# AI Prism user guide

**English** · [Português (Brasil)](pt-BR/user-guide.md) · [Español](es/user-guide.md)

How to use AI Prism day to day. Each section covers one area of the app.

## Chat: messages and answers

### Reading an answer while it streams

- The answer appears as the model writes it. A blinking cursor means text is
  still arriving.
- When the model calls a tool (Genie One, a Genie agent, a Unity Catalog
  function, a vector search index, Python, an MCP server), a **tool chip**
  appears at that point in the answer. It always shows its state:

  - **Running**: a spinner and the seconds elapsed so far.
  - **Done**: a check mark and how long the call took.
  - **Failed**: a warning sign, how long it took, and the first line of the
    error, so you can see what went wrong without opening the chip.

  Click a chip to see what was asked (the question, the query or the code) and
  what came back.
- **Thinking…** shows only when nothing else says the turn is still working,
  for example while the model decides what to do with a tool result. It never
  appears next to a running tool chip.
- If the model streams its reasoning, it appears in a **Reasoning** panel above
  the answer. The panel stays open while the model is reasoning and collapses
  once the answer starts. Click it to open or close it again.
- Screen readers announce the answer once it is complete, not token by token.

### Code and tables

- Code blocks show the language at the top left. **Copy** copies the code
  exactly as written. The wrap button wraps long lines instead of scrolling
  them sideways; press it again to go back.
- Tables scroll inside their own frame and keep the header row visible while
  you scroll. With the keyboard, Tab to the table and use the arrow keys.

### Charts

- Series colours follow the app theme and the design system your organisation
  selected. When a chart compares two series, such as last quarter and this
  quarter, the earlier one is grey and the current one is coloured.
- **View data** opens the numbers behind the chart as a table. The download
  button saves the chart as a PNG.
- Screen readers read the chart title, its series and the number of categories.

### Generated files: decks, spreadsheets and documents

Every generated file appears as a card with the same layout: an icon, the
title, a short description (slide count, number of tabs, document type) and
the actions. The main action opens the file in its studio. A spreadsheet card
also has **Download** for the `.xlsx` file. A document card shows the first
paragraph of the document. When the chat sits in a narrow column next to an
open studio, the actions move under the title, so the title stays readable.

### When an answer stops early or fails

- **The turn stopped early** (the model repeated the same call, or hit the
  limit on tool rounds or time): a blue note under the answer explains why. The
  answer above it uses the data gathered so far. **Retry** generates the
  answer again; to continue from where it stopped, send a follow-up message.
- **The answer came back incomplete or failed** (the output limit was reached,
  or the AI Gateway returned an error): a red note explains what happened, with
  **Retry**.
- **No answer arrived at all**: the row says so instead of staying empty.
- Copy, Listen, Export PDF and Regenerate appear only under a finished answer
  that has content and did not fail. Under a failed answer, even one with some
  text, **Retry** in the red note is the only action; you can still select the
  text and copy it by hand.

### Message actions

- Under each answer: **Copy**, **Listen**, **Export PDF** and
  **Regenerate**. When you regenerated an answer, arrows switch between its
  versions.
- On your own messages, **Edit** and **Copy message** appear when you hover
  over the message with a mouse or move the keyboard focus to it. On a phone or
  tablet, tap your message to show them, and tap it again to hide them.
- Every action has a name that screen readers announce, and a target of at
  least 32 × 32 px with a mouse and 44 × 44 px on touch screens.
