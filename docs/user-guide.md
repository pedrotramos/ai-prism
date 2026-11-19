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

## Navigation

### The sidebar

The sidebar on the left lists everything you need to move around, in this
order:

1. **New chat** starts an empty conversation. The AI Prism logo at the top
   does the same.
2. **Search chats** opens the History page with the search box ready.
3. **Your conversations**, newest first, grouped by Today, Yesterday, Last 7
   days, Last 30 days and Older. Select a title to open it. Hover a row, or
   move to it with the keyboard, to show **Rename** and **Delete**.
4. **Your account and Settings**, at the bottom left: the e-mail you are
   signed in with and the gear that opens Settings. On a phone this is the way
   to reach Settings: the gear closes the sidebar and opens them.

While the list loads you see grey placeholder rows of the same size, so
nothing jumps when the conversations arrive. With no conversations yet, the
list says so and offers **Start your first chat**.

### Collapsed sidebar

On a computer, the arrow next to the logo collapses the sidebar into a narrow
rail with the same actions as icons: expand, New chat, Search chats, Settings
and your account. Hover an icon to see its name. Your choice is remembered on
this browser.

### On a phone

On a phone the sidebar is hidden. Open it with the menu button at the top
left of the screen. While it is open:

- the rest of the screen is dimmed and cannot be used;
- the keyboard stays inside the sidebar (Tab and Shift+Tab cycle through it);
- **Esc**, the close button or a tap on the dimmed area closes it, and you
  return to where you were.

The open conversation's row shows its Rename and Delete buttons. To rename or
delete other conversations, use the History page, where every row shows them.

### History

The History page lists every conversation and lets you:

- **search by topic**: the search is semantic, so it finds a chat by what it
  was about, not only by the words in its title. Each result shows a match
  score. **Esc** or the clear button empties the search;
- **sort** by newest or oldest first;
- **select** conversations with the checkboxes (or **Select all**) and delete
  them together;
- **rename** or **delete** a single conversation with the buttons at the end
  of its row.

When a search finds nothing, the page suggests other words and offers
**Clear search**. With no conversations at all, it offers **New chat**.

### Starting a chat

A new chat opens with a greeting and a few suggestions to start from:
asking your company's data a question, creating a presentation, building a
spreadsheet, drafting a document, generating an image and help with writing.
The first suggestion is highlighted as the most useful starting point.

Selecting a suggestion fills in the message box with the start of a request,
for example "Create a 6-slide presentation about ", and puts the cursor at the
end. Finish the sentence and send it, or change it first.

Only suggestions that work in this installation appear: the data suggestion
needs a data tool (such as Genie One) that your administrator allows and that
is turned on in the Tools menu; the image suggestion needs an image model and
the image tool.

### Language and theme

The interface is available in English, Brazilian Portuguese and Spanish. With
the interface language set to **Default (browser)** (Settings, Preferences),
AI Prism follows your browser's language. If your browser uses any other language, the
interface is shown in English.

Switching between light and dark themes fades the colours over 200 ms. If
your operating system is set to reduce motion, the switch is instant.

### Keyboard

| Key | Where | What it does |
|---|---|---|
| Tab / Shift+Tab | everywhere | Moves between controls; a focus ring shows where you are |
| Esc | sidebar on a phone | Closes the sidebar |
| Esc | History search | Clears the search |
| Esc | renaming a conversation | Cancels the rename |
| Enter | renaming a conversation | Saves the new name |

## Composer

The composer is the message box at the bottom of every chat. Type your
request, attach what the model should read, and send.

### Writing and sending

- **Enter** sends the message. **Shift+Enter** starts a new line.
- The box grows with your text, up to about eight lines; after that it
  scrolls.
- Your message appears in the conversation as soon as you send it, before the
  answer starts.
- While an answer is being written, the Send button becomes **Stop**.
- Nothing asks you to confirm: a message sends and a command runs straight
  away.

### Adding files and images

Select **+** (left of the box) to open a short menu:

| Item | What it does |
|---|---|
| **Attach documents** | Pick documents, spreadsheets, PDFs or images. Their text is read and sent with your message. |
| **Add images** | Pick only images: screenshots, photos, diagrams. Vision models look at them. |
| **Add audio or video** | Shown only when your workspace transcribes media. The recording is turned into text before the model reads it. |
| **Commands** | Opens the command menu (the same as typing `/`). |

You can also **paste** a screenshot or a copied file into the box, or **drag
and drop** files onto the composer. Each attachment shows as a chip above the
box. Images show a thumbnail. Remove an attachment with its **×** button. A
message takes up to 10 attachments.

### Commands

Type `/` at the start of the box to open the command menu. Keep typing to
filter it. Each command has a name in every interface language, and accents
are optional: `/historico`, `/histórico`, `/history` and `/historial` all
work. Extra spaces at the end are ignored.

| Command (pt · en · es) | What it does |
|---|---|
| `/compactar` · `/compact` · `/compactar` | Summarizes the conversation so far to free up context. Text after the command tells the summary what to keep, for example `/compact keep the numbers`. |
| `/contexto` · `/context` · `/contexto` | Shows how much of the model's context this chat uses. |
| `/nova` · `/new` · `/nueva` | Starts a new chat. |
| `/modelo` · `/model` · `/modelo` | Lists the models; pick one to switch this chat to it. Text after the command filters the list, for example `/model sonnet`. |
| `/skills` | Opens your skills in Settings. |
| `/custo` · `/cost` · `/costo` | Shows what this chat has cost. |
| `/historico` · `/history` · `/historial` | Opens the chat history. |
| `/configuracoes` · `/settings` · `/ajustes` | Opens Settings. |
| `/ajuda` · `/help` · `/ayuda` | Lists the commands available here and the keyboard shortcuts. |

The menu only lists commands that work in your installation. A command that
isn't available, or any other text that starts with `/`, is sent to the model
as an ordinary message.

### Voice

- The **microphone** dictates into the box, in the language of the interface.
  Select it again to stop.
- The **waveform** button opens voice mode, a spoken conversation with the
  model.

Dictation needs a browser with speech recognition, such as Chrome or Edge.

### Keyboard and accessibility

| Key | Where | Action |
|---|---|---|
| Enter | message box | send, or pick the highlighted command |
| Shift+Enter | message box | new line |
| `/` | start of the box | open the command menu |
| ↑ / ↓ | command menu | move the highlight |
| Tab | command menu | pick the highlighted command |
| Esc | any menu or the help | close it; your text stays |
| Enter, Space or ↓ | **+** button | open the menu on the first item |
| ↑ / ↓, Home / End | **+** menu | move between items |

The composer works without a mouse. Screen readers announce the box as a
combo box: when `/` opens the suggestions they read how many there are, and
read the highlighted one as you move with the arrows. Shift+Enter still adds
lines. Buttons are at least 44 px tall on phones and 32 px on larger screens.
The focused element always shows a visible outline.

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
- Besides bar, line, area and pie charts, an answer can show four analysis
  views. Ask for them in your own words ("break revenue down by region and
  channel", "how is the ticket size distributed?"):
  - **Pivot table**: one dimension in the rows, another in the columns, the
    sum of a measure in each cell, with row, column and grand totals. An empty
    combination shows a dash, not a zero.
  - **Heatmap**: the same grid, each cell shaded from light to strong by its
    value, with the value printed in the cell and a low-to-high legend. An
    empty cell has a dashed outline and no colour.
  - **Scatter**: two measures plotted against each other, one point per row.
    Groups use a different colour and a different marker shape, so they can
    be told apart without colour.
  - **Histogram**: how the values of one measure are distributed, as
    adjacent bars, one per range.
- When you attach a spreadsheet or CSV, or a data tool such as Genie returns
  rows, the app prepares these views from the real rows. The assistant picks
  one; it does not make up the numbers. Maps are not available.
- In a generated spreadsheet (.xlsx), scatter and histogram charts are native
  Excel charts linked to the cells, and a heatmap is a colour scale on the
  table's value cells.

### Generated files: decks, spreadsheets and documents

Every generated file appears as a card with the same layout: an icon, the
title, a short description (slide count, number of tabs, document type) and
the actions. The main action opens the file in its studio. A spreadsheet card
also has **Download** for the `.xlsx` file. A document card shows the first
paragraph of the document. When the chat sits in a narrow column next to an
open studio, the actions move under the title, so the title stays readable.

The model can also make these files with a tool call while it answers
(**Create deck**, **Create spreadsheet**, **Create document**, and **Update …**
to revise one from the same chat). The tool shows as a chip in the answer; a
deck builds slide by slide while the chip runs, and the card appears where the
tool was called. An update makes a new version of the file: the earlier answer
keeps the version it showed. A file only counts once the answer is saved: if you
stop the answer, no file from it is kept. A tool that fails (for example, an
update on a file the model cannot find) shows a red chip and the answer goes on.

### When an answer stops early or fails

- **The turn stopped early** (the model repeated the same call, or hit the
  limit on tool rounds or time): a blue note under the answer explains why. The
  answer above it uses the data gathered so far. **Retry** generates the
  answer again; to continue from where it stopped, send a follow-up message.
- **The answer came back incomplete or failed** (the output limit was reached,
  or the AI Gateway returned an error): a red note explains what happened, with
  **Retry**.
- **No answer arrived at all**: the row says so instead of staying empty.
- **One part of an answer cannot be shown** (a chart, a table or a file card
  with broken data): only that part becomes a note, "Could not display this
  part of the message.", with **Details**. The rest of the answer still shows.
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

## Settings

Open Settings with the gear in the top bar or at the bottom of the sidebar, or
with `/settings`. It opens as a dialog: focus moves into it, Tab and Shift+Tab
stay inside, and Escape, the close button or **Done** close it and return focus
to the button that opened it.

### Sections

The sections are grouped so there are never more than seven:

| Group | Sections | Who sees it |
|---|---|---|
| Personal | Preferences, MCP connections | everyone |
| Workspace | Skills, Design system | everyone |
| Admin | Models (LLM), Tools, Administrators | admins |

- **Preferences** holds appearance, interface and response language,
  notifications and the response tone and system prompt. The image model is
  under **Advanced**, already set to the organization's recommended model.
- **Tools** turns tool groups on or off for the organization and, below them,
  manages the **MCP catalog** that users can connect to.
- On a phone, two buttons at the top choose **Personal** or **Organization**,
  and the sections of that area scroll sideways under them.

### Saving and errors

- On/off controls are switches that screen readers announce with their state.
- Each label sits above its field. A value that cannot be saved, such as a
  negative price, is marked on the field with the reason, and nothing is saved
  until it is fixed.
- After a change is saved, **Saved** appears next to it. When saving fails, the
  error stays next to the change until the next attempt.
- **Models (LLM)** lists each model on one line. Use the arrow next to a name
  to open its display name, description and prices.

## Projects

A project groups chats, instructions and source files, and can be shared with
people and workspace groups. The screens arrive with the projects UI; this
section describes the rules they follow (the API is `/api/projects`).

### Roles

Each member has one role. A higher role can do everything a lower one can.

| Action | view | manage | owner |
|---|---|---|---|
| Read the project, its files and its chats | yes | yes | yes |
| Send messages in the project's chats, start a chat in the project | yes | yes | yes |
| Move one of your own chats into the project | yes | yes | yes |
| Edit the name, description and instructions | | yes | yes |
| Add or remove files | | yes | yes |
| Add, change or remove members (up to **manage**) | | yes | yes |
| Make someone an owner, change or remove an owner | | | yes |
| Delete the project | | | yes |

- Whoever creates a project is its first owner. A project always keeps at least
  one person (not a group) as owner, so the last owner cannot leave or be
  demoted.
- Any member can leave a project.
- Members are people (their e-mail) or workspace groups (the group name). A
  group counts only while the workspace confirms that you belong to it: if that
  check fails, the group gives you nothing until it works again.
- App admins have no special access to projects. They see a project only if
  they are members.

### Chats in a project

- A chat in a project belongs to the project. Every member reads it and can
  send messages in it. While someone's answer is being written, the others see
  who sent it, and a second message waits until that answer ends.
- Access follows your current role. If you leave a project, or are removed, you
  lose its chats, including the ones you started.
- The person who started a chat can take it out of the project, back to their
  own chats, if they have **manage** or **owner**.
- Deleting a project deletes its chats.
- The organization's chat retention period does not apply to project chats:
  they stay until they are deleted or their project is.

### Files

Files added to a project are kept as their text (PDF, Word, PowerPoint, Excel
and text formats, like chat attachments). Up to 10 files of 25 MB each per
upload, and 50 files per project.
