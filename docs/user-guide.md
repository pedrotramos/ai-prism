# User guide

**English** · [Português (Brasil)](pt-BR/user-guide.md) · [Español](es/user-guide.md)

How to find your way around AI Prism. Each section covers one part of the
screen; sections for the composer, the chat and the app shell are added next
to this one.

## Shell

The shell is everything around a conversation: the top bar, the links to a
conversation, notifications and what happens when something fails.

### The top bar

The bar above the conversation holds, from left to right:

| Control | What it does |
|---|---|
| Menu (phones only) | Opens the conversation list. |
| Model | The model that answers in this conversation. The list shows three **Recommended** models first. **More models** opens the rest of the catalog, grouped by provider, with a search box. A model marked **Text only** does not accept images (or **Images**, when most models in your catalog are text only). |
| Tools | The tools the model may call in this conversation (Genie One, image generation, Genie Agents, Unity Catalog functions, Vector Search indexes, MCP connections). The number on the icon is how many are on. |
| Cost meter | What you spent this month and, inside a conversation, what this conversation cost so far, at list price. On a phone only the gauge icon shows; tap it for the figures. |
| Settings | Preferences, skills, MCP connections and, for admins, organization settings. |

The Model, Tools and Cost meter panels close with **Esc** or a click outside, and keyboard focus
goes back to the button that opened them. In the model list, the arrow keys move between models.
The cost panel also closes when you switch conversation or use the browser's back and forward
buttons.

The model and tool choices are saved on the conversation: reopening it brings them back.

### Links to a conversation

Every conversation has its own address (`…/#/chat/<id>`), so you can bookmark it or use the
browser's back and forward buttons. `…/#/history` opens the list of all conversations.

If a link points to a conversation that does not exist, was deleted or is not yours, AI Prism
says **Conversation not found** and offers **Back to history** and **New chat**. It never opens
someone else's conversation: every read is limited to the signed-in user.

### When something goes wrong

**A turn fails.** If the model or the service cannot answer (for example the AI Gateway is
temporarily unavailable), your message stays in the conversation and an error card appears where
the answer would be. The card says what happened in plain words and offers:

- **Retry**: asks again. If the server already stored your message, it generates the missing
  answer; if not, it sends the message again with the same attachments.
- **Copy prompt**: copies your message, if you would rather rephrase it.
- **Details**: the exact message from the server, useful when you report the problem to an
  admin.

The same card appears when **Regenerate** or **Generate answer** fails. When a regeneration fails
before a new answer is stored, the previous version stays.

**A message cannot be displayed.** If one stored message is malformed, only that message is
replaced by "Could not display this message." The rest of the conversation keeps working.

**Something breaks the whole page.** You see "Something went wrong" with a **Reload** button.
Your conversations are stored on the server, so reloading loses nothing that was sent.

**Notifications.** Short messages appear in the top-right corner and disappear on their own after
a few seconds (errors stay a little longer). Pointing at a notification, or moving keyboard focus
into it, keeps it open so you can read **Details**. Screen readers announce them; errors are
announced immediately.

#### What the error messages mean

| Message | Usual cause | What to do |
|---|---|---|
| Can't reach AI Prism | Your network, VPN or proxy dropped the connection. | Check the connection and retry. |
| The service is temporarily unavailable | The AI Gateway, the workspace or the database did not answer. | Retry in a moment. |
| Too many requests right now | A rate limit of the model endpoint or of AI Prism. | Wait a few seconds and retry. |
| Your session has expired | The sign-in token of the Databricks Apps proxy expired. | Reload the page. |
| You don't have permission for this | Your user lacks a grant (catalog, Genie Agent, endpoint). | Ask your workspace admin. |
| That is too large to send | A file or message over the upload limit. | Send a smaller file or split it. |
| This took too long and was stopped | A model or tool call hit its time limit. | Retry, or ask for something smaller. |
| Something went wrong on the server | An unexpected server error. | Retry; if it repeats, send the **Details** to your admin. |

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
