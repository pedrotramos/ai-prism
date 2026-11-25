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
| Title | The name of the open conversation. On a project page it is a trail such as **Projects / Revenue analytics**; select **Projects** to go back. |
| Share | Puts the conversation in a project and opens that project's members (see [Sharing a conversation](#sharing-a-conversation)). Inside a conversation only. |
| Cost pill | What you spent this month; inside a conversation it shows what this conversation cost. Select it for the breakdown. On a phone only the gauge icon shows; tap it for the figures. |
| Artifact panel | Shows or hides the panel with the deck, spreadsheet or document of this conversation. Only when the conversation has one. |
| Settings | Preferences, skills, MCP connections and, for admins, organization settings. |

The model, the tools and the response style are not in the top bar: they sit inside the message box
(see [The pickers](#the-pickers)).

The cost panel closes with **Esc** or a click outside, and keyboard focus goes back to the button that
opened it. It also closes when you switch conversation or use the browser's back and forward buttons.
It shows **Spent this month** with the date it resets and, inside a conversation, **This conversation**
with the number of answers and their cost. Every figure is an estimate at list price, recorded on each
model call. The amount billed is in your organization's cost dashboard.

The model, tool and style choices are saved on the conversation: reopening it brings them back.

### Reasoning effort

Some models can think harder before they answer. When the selected model supports it, its list shows a
**Reasoning effort** control: **Auto**, **Low**, **Medium** or **High**. Higher effort is slower and costs
more (the thinking tokens are billed as output), so leave it on **Auto** unless a question needs it. With
**Auto**, AI Prism sends no effort at all and the model behaves as usual. The choice applies to the
messages you send next, including **Continue** and **Regenerate**, and is not saved on the conversation: a
new browser tab starts on **Auto**. Pick a model without the control and nothing is sent either.

The model descriptions in the list follow the language of the interface (English, Portuguese or
Spanish). A description an admin edited in **Settings → Models** is shown as written.

### Sharing a conversation

**Share** (in the top bar, and in the header of each studio) puts the conversation in a project, so the
project's members can read it, and then opens the project's members so you can add people.

- In a personal conversation it first asks which project to move it to. Everyone in that project will see
  the conversation. If you are not in any project yet, the dialog says so.
- A conversation that is already in a project goes straight to the project's members and moves nothing.
- If the list of projects is still loading when you select **Share**, the click waits for it. If the list
  cannot be loaded, an error says so and the conversation stays where it is.
- When you share from a studio, the studio closes and the project page opens. If the document has unsaved
  edits, the usual question comes first, the same as when you close the studio: **Keep editing**, **Save**
  or **Discard changes**.
- Roles are the ones in [Projects](#roles). A temporary chat cannot be moved into a project.

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
3. **Projects**, **Agents** and **Costs**. **Agents** appears when scheduled
   agents are turned on for your organization; **Costs** is for admins only.
4. **Your projects**, each with a small coloured dot and a **+** that starts a
   chat inside it, followed by **your conversations**, newest first, grouped by
   Today, Yesterday, Last 7 days, Last 30 days and Older. Select a title to open
   it. Hover a row, or move to it with the keyboard, to show **Move to project**,
   **Rename** and **Delete**.
5. **What you spent this month**, above your account: the total for the month
   and the note "List-price estimate". It is the same figure as the cost pill,
   and every user sees their own. If it cannot be loaded it says so and offers
   **Try again**; a figure that is out of date is marked.
6. **Your account**, at the bottom left: the e-mail you are signed in with, a
   button that switches between the light and dark theme, and the gear that
   opens Settings. On a phone the gear closes the sidebar and opens them.

While the list loads you see grey placeholder rows of the same size, so
nothing jumps when the conversations arrive. With no conversations yet, the
list says so and offers **Start your first chat**.

### Collapsed sidebar

On a computer, the arrow next to the logo collapses the sidebar into a narrow
rail with the same actions as icons: expand, New chat, Search chats, Projects,
Agents, Costs, the theme, Settings and your account. Hover an icon to see its
name. Your choice is remembered on this browser.

The sidebar is a rail by itself when the window is 1100 px wide or less. Hover
or focus the rail and the full sidebar opens over the conversation; **Esc**
closes it.

### On a phone

On a phone (760 px or less) the sidebar is hidden. Open it with the menu button
at the top left of the screen. While it is open:

- the rest of the screen is dimmed and cannot be used;
- the keyboard stays inside the sidebar (Tab and Shift+Tab cycle through it);
- **Esc**, the close button or a tap on the dimmed area closes it, and you
  return to where you were.

The open conversation's row shows its Move to project, Rename and Delete
buttons. To rename or delete other conversations, use the History page, where
every row shows them.

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

A new chat is the Home screen: a greeting ("What shall we analyze?", with your
first name when it can be read from your e-mail), a line saying what you can
ask, the message box and three start cards:

- **Analyze data**: ask a question about the data you can access;
- **Create an artifact**: a deck, a document or a spreadsheet, ready to edit;
- **Search documents**: find answers in your documents and policies.

Selecting a card fills in the message box with the start of a request, for
example "Create a 5-slide presentation about ", and puts the cursor at the end.
Finish the sentence and send it, or change it first.

Above the message box, **No project** lets you start the chat inside a project
instead (it then uses the project's instructions and files). Below the cards,
**Pick up where you left off** lists your most recent chats; select one to open
it (up to three).

### Temporary chats

For a conversation that should leave no trace, open the **+** menu in the
message box and choose **Temporary chat**. The next message you send starts a
chat that behaves like any other while it is open, with one difference: nothing
is kept afterwards.

- It is **deleted when you leave it**: starting a new chat, opening another
  chat or closing the tab.
- It is **not searchable**: it never appears in search results or in History,
  and it is not used to find related chats.
- It teaches nothing to **Memory**: no fact is learned from it. Your saved
  memory is still used to answer, because it is yours.
- It is marked with a padlock and **Temporary** in the sidebar and at the top
  of the chat.

If a tab dies before the chat could be deleted, the server deletes it once it
has been idle for 24 hours, whatever the retention setting. A temporary chat
cannot be moved into a project, and an ordinary chat cannot be turned into a
temporary one (or the reverse). Admins can see only how many temporary chats
were started, never who started them, their titles or their content.

### Language and theme

The interface is available in English, Brazilian Portuguese and Spanish. With
the interface language set to **Default (browser)** (Settings, Preferences),
AI Prism follows your browser's language. If your browser uses any other language, the
interface is shown in English.

The theme follows your system (light or dark) until you choose one: use the moon button at the bottom of the
sidebar, or **Appearance** in Settings → Preferences, which offers **System**, **Light** and **Dark**.
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

### The pickers

The model, the tools and the response style are chosen inside the message box,
next to the text you are writing. From left to right, under the box:

| Control | What it does |
|---|---|
| **+** | Attach files, add images, start a temporary chat, open the commands (see below). |
| Tools | The tools the model may call in this conversation (Genie One, image generation, Python, Genie Agents, Unity Catalog functions, Vector Search indexes, MCP connections). The button shows the icons of what is on and how many. The panel has **Enabled tools**, with a switch for each, and **Add tools**: Genie Agents, Unity Catalog functions and Vector Search indexes each open a list to pick from, and External MCPs lists your connections. What you pick appears as removable chips above the box. Everything runs with your own login, and your admin decides what shows up. |
| Response style | **Default**, **Concise**, **Executive**, **Engineer**, **Data analyst** or **Teacher**, each with a one-line description, plus **Personal instructions** (your own text from Settings). The style is saved on the conversation. |
| Model | The model that answers in this conversation, with the mark of its provider. The list shows the **Recommended** models first, the one new chats start with is tagged **Default**, and each model shows a short description and bars for its relative cost per answer. **More models** opens the rest of the catalog, with a search box. A model marked **Text only** does not accept images (or **Images**, when most models in your catalog are text only). |
| Microphone and waveform | Dictation and voice mode (see Voice). |
| Send | Sends the message. It turns into **Stop** while an answer is being written. |

The Tools, Style and Model panels close with **Esc** or a click outside, and keyboard focus goes back to
the button that opened them. In the model list the arrow keys move between models. On a phone each
control shows only its icon, and the panels fit the screen.

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
| `/skills` | Opens your skills in Settings. The built-in skills (presentations, spreadsheets, charts, images, documents) are listed first, read-only, in your interface language. |
| `/custo` · `/cost` · `/costo` | Shows what this chat has cost. |
| `/historico` · `/history` · `/historial` | Opens the chat history. |
| `/configuracoes` · `/settings` · `/ajustes` | Opens Settings. |
| `/ajuda` · `/help` · `/ayuda` | Lists the commands available here and the keyboard shortcuts. |

The same menu also holds shortcuts that start an artifact or a tool request. They only fill in the box (nothing is sent), and you
finish the sentence:

| Shortcut (en) | Fills in |
|---|---|
| `/deck` | "Create a presentation about " |
| `/memo` | "Write a memo about " |
| `/spreadsheet` | "Build a spreadsheet with " |
| `/image` | "Generate an image of " |
| `/genie` | "Using my company data, " |
| `/python` | "Using Python, " |

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
- Each answer starts with a header: the AI Prism mark and a line such as "with Genie One, Python and
  Vector Search", built from the tools the turn actually used.
- When the model reasons or calls a tool (Genie One, a Genie agent, a Unity Catalog function, a vector
  search index, Python, an MCP server), the steps collect in one collapsible card above the text. While the
  turn works, a thin spectrum line moves along it (it stays still if your system asks for reduced
  motion). When it ends, the card reads **Worked for 4.8s in 2 steps** and lists each step with the time
  it took and its state: running, done, or failed with the first line of the error, so you can see what
  went wrong without opening it. **View details** shows what was asked and what came back; for Genie it
  also offers **View generated SQL**, and for Python **View code**. The names of the tools (Web search,
  Image generator, the document, deck and spreadsheet tools) follow your reply language.
- One answer holds up to 12 blocks (charts, tables, decks, documents, images).
  If the model writes more, the extra ones are left out and a note at the end of
  the answer says how many; ask for them in a new message.
- **Thinking…** shows only when nothing else says the turn is still working,
  for example while the model decides what to do with a tool result. It never
  appears next to a running tool step.
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

- A chart sits in a frame with its title and subtitle (for example the source) at the top and **Export as
  image (PNG)** at the bottom. Series colours follow the app theme and the design system your organisation
  selected. When a chart compares two series, such as last quarter and this quarter, the earlier one is
  grey and the current one is coloured.
- The switch at the top right of the frame (**Chart view**) changes how the same data is drawn. It only
  offers views the data fits: **Bar**, **Line** and **Area**, **Pie** when there is a single series of
  values that are not negative, and **Table** always. **Table** is a tab with the same rows as the chart.
  Switching to another view and back loses nothing.
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

Every generated file appears as a card with the same layout: the title, a short description (slide
count, number of tabs, document type) and the actions. A deck card shows its first slide as the
thumbnail; spreadsheet and document cards show the icon of their kind instead. The main button opens the
file in its studio (**Open in Slides Studio**, **Open studio**, **Open**). A spreadsheet card also has
**Download** for the `.xlsx` file. A document card shows the first paragraph of the document. When the
chat sits in a narrow column next to an open studio, the actions move under the title, so the title
stays readable.

The model can also make these files with a tool call while it answers
(**Create deck**, **Create spreadsheet**, **Create document**, and **Update …**
to revise one from the same chat). The tool shows as a step in the answer's steps card; a
deck builds slide by slide while the step runs, and the file card appears where the
tool was called. An update makes a new version of the file: the earlier answer
keeps the version it showed. A file only counts once the answer is saved: if you
stop the answer, no file from it is kept. A tool that fails (for example, an
update on a file the model cannot find) shows a failed step and the answer goes on.

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

- Under each answer: **Copy**, **Regenerate**, **Listen**, **Export PDF** and, when you regenerated an
  answer, its versions ("2 of 2") with arrows to switch between them. At the right of the same line,
  the model that wrote it (with its provider's mark), the tokens and the estimated cost.
- On your own messages, **Edit** and **Copy message** appear when you hover
  over the message with a mouse or move the keyboard focus to it. On a phone or
  tablet, tap your message to show them, and tap it again to hide them. Editing
  turns the message into a box with **Cancel** and **Save and regenerate**.
- Every action has a name that screen readers announce, and a target of at
  least 32 × 32 px with a mouse and 44 × 44 px on touch screens.

## Studios

The deck, spreadsheet and document studios share one layout, so what you learn
in one works in the others.

### The studio panel

A studio opens as a panel next to the conversation. Its width follows the window:

- **Above 1100 px** the panel sits beside the chat. The artifact button in the top bar shows or hides it.
- **From 768 to 1100 px** it floats over the chat as a dialog, with a dimmed background; **Esc** or a click
  on the dimmed area closes it and focus goes back to where you were.
- **Below 768 px** it fills the screen (see Keyboard and phones).

Every studio has the same header: the icon of the kind, the name with a line such as **Deck · 3 slides**,
**Document · 60 words** or **Spreadsheet · 2 sheets**, then the actions: **Edit** (deck and document),
**Share**, **Present** (deck), **Export** and close. **Export** is the dark button.

### Editing with AI

Every studio has the same **Edit with AI** panel: an **Apply to** choice, a box
for the instruction, and **Apply** (or ⌘/Ctrl+Enter). In the Slides Studio you
can apply a change to **This slide**, the **Selection** (one element picked in
Edit mode) or the **Whole deck**. In the Spreadsheet Studio you can apply it to
one sheet or the whole workbook. The deck and spreadsheet panels also take a
reference image (paste it or attach it), up to 4. An AI edit in the Slides
Studio whose request is over 46 MiB in total (speaker notes and images
together) is refused before it is sent, with a message that names the limit:
shorten a note or remove an image. The AI edit opens as a preview with
**Accept & save** and **Discard**; nothing is saved until you accept.

### Saving

The studios save on their own. The status next to the slide tools (deck) or in
the header (spreadsheet, document) reads **Saving…**, then **Saved**. If a save
fails it reads **Couldn't save** with **Retry**, and your change stays on
screen until it is saved. Two places save only when you say so: the deck's
**Edit** mode (**Save** / **Discard**) and the document's hand editor
(**Save**). Leaving either with unsaved changes asks first; nothing else asks
for confirmation.

### Two tabs on the same deck

If the same deck is open in two tabs (or two sessions) and one of them saves,
the other no longer overwrites it silently. The next save from the older tab is
refused and the studio asks what to do: **Reload the saved version** (the
unsaved edits in this tab are discarded) or **Keep mine and overwrite** (this
tab's deck replaces the other one, on purpose). Until you choose, the studio
sends nothing more; **Retry** brings the question back. An AI edit made from an
older copy of the deck asks the same thing before it spends anything. If two AI
edits of the same deck start at once, only the first runs; the other is told
that an AI edit is already running (nothing is spent, and your instruction
stays in the box), and can be sent again in a moment. Only the
deck studio does this; spreadsheets and documents still keep the last save.

### Slides

- **Building a deck.** While the model writes a deck, the studio shows
  **Building slide N of M** (or **Building slide N…** when the total is not
  known yet), and **Deck ready · N slides** when it lands.
- **Deleting a slide.** **Delete slide** sits apart from **Add** and
  **Duplicate**. It deletes at once and offers **Undo**. The offer stays
  available for 30 minutes, also after you reload the page; Undo puts the slide
  back where it was and saves the deck.
- **Edit mode.** **Edit** opens the editor. On the left, two tabs: **Slides** (the thumbnails) and
  **Layers** (the tree of elements on the slide). Beside the slide, a vertical strip of drawing tools
  (select, text, shapes, line, arrow, image). On the right, the **Design** panel with the properties of
  the selected element. A path above the properties shows where the selected element sits in the slide
  (for example *Slide › Group › Title*); click a step to select it. **Undo** and **Redo** appear in the
  header while you edit, with **Discard** and **Save**.
- **Quick actions on the selection.** When you select an element, a small bar appears over the slide with
  **Adjust with AI**, **More executive**, **Shorten** and **Translate**. **Adjust with AI** and
  **Translate** set **Apply to** to **Selection** and move you to the Edit with AI box (**Translate**
  starts the sentence "Translate this element to " for you to finish with the language). **More
  executive** and **Shorten** send a ready-made request for that element straight away. Like every AI
  edit, the result opens as a preview with **Accept & save** and **Discard**.

### Spreadsheets

- The studio shows the grid, a formula bar above it (the name box with the selected cell or range, and
  the formula of the active cell) and the sheet tabs below it, with a legend of the cell colours
  (**Input**, **Formula**, **Highlight**). The grid is read-only: values change through the AI panel, or
  by exporting the `.xlsx` and opening it in Excel.
- **AI actions on the selection.** Select a cell or drag a range, and a small bar appears next to it:
  **Ask AI**, **Add % variance**, **Chart from selection** (only for a range of several cells) and,
  when the selection holds a formula, **Explain formula**. The bar opens with the arrow keys and **Esc** closes it. Each action sends the same
  kind of AI edit as the panel, with the selected range written into the request, and the result opens
  as a preview to accept or discard.
- **Explain formula** asks for a plain-language explanation of what the formula calculates and writes it
  as a note under its table. It does not change any value, formula or format.

### Documents

The document opens on a white page in both themes, as it will look in the exported file. The formatting
bar has a **Text style** menu (paragraph, headings and so on) with the usual marks, lists and tables.
**Edit** switches to the hand editor. There are no suggestions, versions or comments.

### Export

Each studio has one **Export** button with the formats it offers: PowerPoint
with universal or brand fonts (deck), Excel (spreadsheet), and Word, Markdown or
PDF (document). The menu works with the arrow keys; Esc closes it.

### Keyboard and phones

- **←** / **→** (and Page Up / Page Down, Home / End) change slide, except
  while you type in a field or move a selected element on the slide.
- **Esc** works from the inside out: it leaves a text box first, then drops the
  selection, then leaves Edit mode (deck) or the hand editor (document). Only
  then does it close the spreadsheet or document studio.
- On a phone every studio fills the screen. The top-left button reads
  **Back**, and the phone's back gesture also leaves the studio. With unsaved
  changes it asks before leaving.
- Studio buttons are at least 32 px (40 px on a phone), and the studios do not
  animate when the system asks for reduced motion.

## Settings

Open Settings with the gear in the top bar or at the bottom of the sidebar, or
with `/settings`. It opens as a dialog: focus moves into it, Tab and Shift+Tab
stay inside, and Escape, the close button or **Done** close it and return focus
to the button that opened it.

### Sections

The navigation on the left has two groups:

| Group | Sections | Who sees it |
|---|---|---|
| Your account | Preferences, MCP connections, Skills, Design system | everyone |
| Admin (with an **Admin** badge) | Models (LLM), Tools, Administrators, Agents | admins |

- **Preferences** holds, from the top: **Appearance** (**System**, **Light** or **Dark**), the interface and
  response language, notifications, **Memory**, the response tone and system prompt, **Defaults for new
  chats** and the image model.
  - **Defaults for new chats**: the **Model** a new chat starts with, the **Tools** it starts with (a
    read-only summary: your organization decides which tools exist, and you change them per chat in the
    message box) and **Read aloud**, the speed of the voice that reads answers (**Play a sample** lets you
    hear it). The image model is set to the organization's recommended one.
  - Projects can set their own defaults, and those take priority.
- **Design system** shows the active design system and lets you import, edit, duplicate and delete your own.
  Admins can also publish one as the organization default (see below).
- **Tools** turns tool groups on or off for the organization. It has two lists: **On by default** (Genie
  One, Image Generator, Python, Web Search, Memory, MCP Apps) and **Catalogs to choose from in each
  conversation** (Genie Agents, Unity Catalog functions, Vector Search, MCP). Below them, **MCP catalog**
  manages the MCP services users can connect to.
- On a phone, two buttons at the top choose **Personal** or **Organization**,
  and the sections of that area scroll sideways under them.

### Saving and errors

- On/off controls are switches that screen readers announce with their state.
- Each label sits above its field. A value that cannot be saved, such as a
  negative price, is marked on the field with the reason, and nothing is saved
  until it is fixed.
- After a change is saved, **Saved** appears next to it. When saving fails, the
  error stays next to the change until the next attempt.

### Models (admin)

**Models (LLM)** is a table with one row per model: the mark of its provider, the name (select the arrow
to open its display name, description and prices), the endpoint id, the **Price** and an **Active** switch.

- The **Price** column says where the price comes from: **List price** (the curated price that ships with
  the app, updated with it) or **Negotiated** (you filled in your own). Leave the price fields blank to use
  the list price.
- **Active** takes the place of the old remove button. Switching a model off removes it from everyone's
  picker; the row stays in the list, so switching it back on undoes it.
- The arrows reorder the models. The first one is the default for new chats. **Add model** adds an
  endpoint that is not in the catalog yet; it needs the input and output cost per million tokens.

### Design system

**Design system** has a selector for the design systems you can use, with actions to preview, edit,
duplicate, publish to the whole organization and delete. Below, three tabs show what the design system
carries:

- **Brand**: import a folder or loose files (`.pptx`, `.json`, fonts, logos, icons and images), start a new
  template, download the starter kit, and see the colours and fonts that were extracted.
- **Assets**: the logo and the icons that AI Prism reuses before it creates new ones. An image that
  repeats on almost every slide of the source file is detected as a watermark and never enters generated
  decks; **Review** lets you check it.
- **Charts**: the series colours that charts in decks, documents and spreadsheets draw from, in this
  order. A design system with none falls back to the neutral AI Prism palette.

Nothing was removed from the previous screen: reorder, edit, duplicate, publish for the organization,
delete, import folder or files and download the kit are all still there.

### Access and policies (admin)

The **Administrators** section is the **Access and policies** page. It lists the administrators (the owner
is always one) as tags in the field where you add more, and it has a **Policies** list with links to the
AI Gateway documentation on guardrails and to the Databricks documentation on budgets. Guardrails and spending
limits are configured there, not in AI Prism. Only users or groups that already have access to the app in
Databricks Apps can be promoted to admin.

## Projects

A project groups chats, instructions and source files, and can be shared with
people and workspace groups. This section covers the screens and the rules they
follow.

### Using projects in the app

- **Open them** from **Projects** in the sidebar (or `#/projects`). Type a name
  and choose **Create project**. Each project opens on one page with four
  regions: Chats in the main column, and Instructions, Files and Members in the
  column beside it. At the top, a trail (**Projects / name**) leads back to the
  list.
- **Colour.** Every project gets one colour, chosen from its id. You see the same
  coloured dot on the project page, in the sidebar and on the Home project
  picker; it does not change when you rename the project.
- **Share project** (top right of the page) takes you to the Members form.
  Member avatars are shown under the project name.
- **Rename or delete** from the top of the project page. Deleting asks once and
  tells you that the project, its files and all of its chats are deleted with
  it, for everyone. Only owners see **Delete project**.
- **Instructions** are saved with **Save**. A counter shows how many characters
  you have used of the server's limit, and **Save** stays off while the text is
  over it.
- **Files**: **Upload files** adds documents. Each file shows whether chats
  read it (**In context**, **Partly in context**, or **Not in context (over
  budget)**), its size in tokens, and a note when its text was cut at upload.
  A file that is too large or of an unsupported type is refused before it is
  sent, with the reason and what to do.
- **Members**: choose Person or Group, type the e-mail or the group name,
  choose a role and **Add**. The role list in each row changes a role; the bin
  removes a member. A viewer sees the list without these controls and can
  **Leave project**.
- **Chats**: the **New chat in this project** bar above the chats, or the **+** beside a project in
  the sidebar, starts a chat inside the project; so does choosing the project on Home. The sidebar lists a project's
  chats under its name. To put one of your own chats into a project, use the
  folder button on its sidebar row. Temporary chats cannot be in a project and
  have no folder button.
- **In a project chat**, each of your colleagues' messages shows who sent it, and
  a line under the top bar says "<name> is answering…" while someone else's
  answer is being written. A viewer cannot edit a sent prompt or regenerate an
  answer.
- **When something is refused**, the message says which role you need and what
  to do next, for example asking a project owner to change your role. The page
  then reads the project again, so the controls you can no longer use go away.
- Project chats are kept until the project is deleted; the organization's
  retention period does not apply to them.

### Roles

Each member has one role. A higher role can do everything a lower one can.

| Action | view | manage | owner |
|---|---|---|---|
| Read the project, its files and its chats | yes | yes | yes |
| Send messages in the project's chats, start a chat in the project | yes | yes | yes |
| Change what is already in a project chat: edit a sent prompt, regenerate an answer, switch the version shown, answer an assistant's questions, compact the chat | | yes | yes |
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
- Decks, spreadsheets, documents and images that someone generated in a project
  chat are visible to every member, read-only: you can open them and export
  them, but only the person who generated an artifact can edit it (saving, or
  asking the AI to change it, answers "read-only"). To change someone else's
  work, ask the assistant for a new version in your own message.
- Deleting a project deletes its chats and the images generated in them.
- The organization's chat retention period does not apply to project chats:
  they stay until they are deleted or their project is.

### Files

Files added to a project are kept as their text (PDF, Word, PowerPoint, Excel
and text formats, like chat attachments). Up to 10 files of 25 MB each per
upload, and 50 files per project. Only the first 50,000 characters of each file
are kept, and the list marks a file that was cut.

### What a project chat reads

- Every chat in a project starts from the project's instructions, which are
  always read in full, and from its files. Every member sees the same context,
  whatever their role, and nobody outside the project gets any of it.
- The files are read in the order they were added, up to a size limit per
  message (32,000 tokens by default, set by the administrator). The first file
  that no longer fits is read in part when enough room is left, and the rest are
  not read. The assistant is told which files it did not read, so it says so
  when you ask about them.
- The file list shows, for each file, whether chats read it in full, in part or
  not at all, so you know what the answers can rely on. To fit more, remove
  files you no longer need or split a large one.
- Each message in a project chat shows who sent it.

## Memory

AI Prism can remember a few durable facts about you across conversations,
such as how you like answers formatted, your role or team, and the projects
you are working on. It uses them to tailor later answers. Memory belongs to
you: nobody else, admins included, can read your entries.

### What is remembered

- After an answer has finished, a small, fast model reads **only your own
  message** and may keep up to three facts from it. It never reads the
  answer, tool results or web pages. It only looks at short messages that
  say something about you; long or pasted-looking text (quotes, e-mails,
  code) is skipped, and a fact that reads like an instruction, a link or an
  address is never kept. A stopped or failed turn keeps nothing, and
  regenerating an answer does not read the message again.
- You can also add, edit and delete entries yourself (up to 200, each up to
  500 characters). **Forget everything** deletes them all at once.
- Each turn passes at most 10 of your most recently updated entries to the
  model, capped at about 1,500 tokens. They are labelled as notes about you,
  not instructions, so text inside an entry cannot steer the assistant.
- Learning a fact costs a little; that cost appears in your usage as
  **memory**.

### Sensitive topics

Facts about health, politics, religion or personal finances are never learned
automatically. If you add one yourself, it is kept but not used until you
switch on **Include sensitive topics** for that entry. Moving an entry to another
sensitive category switches that consent off again.

### Manage your memory

Open Settings → Preferences → **Memory**. Memory is on by default, and the
section says so, with a short note on what is remembered. Each entry shows its
category; use the pencil to edit it, the bin to delete it, and **Add memory**
to write one yourself.

- **Include sensitive topics** is a checkbox on each entry. Health, politics,
  religion and personal finance categories can only be chosen once it is on
  for that entry, and only then is the entry used in answers.
- **Forget everything** asks once, in a dialog (Escape or Cancel keeps your
  entries), then deletes every entry and tells you how many were deleted.
- If an entry was already deleted elsewhere, or the same fact already exists
  or you reached the limit of 200, the form stays open and says what to do.

### When an admin turns memory off

An admin can turn memory off for the whole organization under Settings →
Tools, with the **Memory** switch. While it is off, nothing is learned, nothing is passed to the model
and the list cannot be opened or edited. You can still delete your entries.
