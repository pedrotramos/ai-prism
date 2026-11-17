# User guide

**English** · [Português (Brasil)](pt-BR/user-guide.md) · [Español](es/user-guide.md)

How to find your way around AI Prism. Each section covers one part of the
screen; sections for the composer, the chat and the app shell are added next
to this one.

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

**Skills.** Your enabled skills also appear in the menu. Picking one, or
typing `/<skill-name>` before your request, pins the skill to that message.
It shows as a chip above the box, applies to the next message only, and can
be removed with its **×**.

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
