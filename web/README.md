# UTG Academic Assistant — Web UI

The Vue 3 + Vite front end for the UTG Academic Assistant: student sign-in, a chat screen and an admin dashboard,
built with Tailwind CSS v4 and [shadcn-vue](https://www.shadcn-vue.com/) components.

## Run

```
npm install
npm run dev
```

Open http://localhost:5173. The API (see the root README) must be running for answers.

## Config

The API base defaults to `http://localhost:5051`. Override it with a Vite env variable, for example in `.env.local`:

```
VITE_API_BASE=http://localhost:5051
```

## Layout

```
src/
├── api.js                 # All calls to the server, incl. the SSE stream parser
├── composables/
│   ├── useAuth.js         # The signed-in student and their session token
│   ├── useChat.js         # The student's chats, saved in localStorage per student
│   ├── useSpeech.js       # Voice input and read-aloud (Web Speech API)
│   ├── useAdmin.js        # Admin session (in memory only) and data
│   └── useTheme.js        # Light / dark / system
├── lib/                   # Markdown rendering, display helpers, and export (text, .ics, .csv)
├── components/
│   ├── AppSidebar.vue     # New chat, recent chats, account menu
│   ├── chat/              # Message, composer, and the schedule shown under an answer
│   ├── admin/             # Sign-in, upload card, sources table
│   └── ui/                # shadcn-vue components (generated; edit freely)
└── views/                 # ChatView (/), AuthView (/login) and AdminView (/admin)
```

## Adding a shadcn-vue component

```
npx shadcn-vue@latest add dialog
```

Components are copied into `src/components/ui/` as plain `.vue` files. Theme colours are the CSS
variables at the top of `src/style.css`.

## Tests

```
npm test
```
