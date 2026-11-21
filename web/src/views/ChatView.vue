<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { RouterLink } from 'vue-router';
import {
  ArrowDown, CalendarClock, CalendarDays, CircleAlert, ClipboardList, Download, FileText, Info, Menu, Printer, SquarePen, UserRound,
} from '@lucide/vue';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import AppSidebar from '@/components/AppSidebar.vue';
import ChatComposer from '@/components/chat/ChatComposer.vue';
import ChatMessage from '@/components/chat/ChatMessage.vue';
import { API_BASE, getHealth } from '@/api';
import { useAuth } from '@/composables/useAuth';
import { useChat } from '@/composables/useChat';
import { useSpeechSynthesis } from '@/composables/useSpeech';
import { answerToText, conversationToText, downloadText, fileNameFrom } from '@/lib/export';

const { user } = useAuth();
const { active, activeId, messages, busy, streaming, lastUserIndex, send, stop, retry, takeLastQuestion, newChat } = useChat();
const speech = useSpeechSynthesis();

const draft = ref('');
const composer = ref(null);
const drawerOpen = ref(false);
const empty = computed(() => messages.value.length === 0);

// Shortcuts under the question box on a new chat
const shortcuts = [
  { icon: CalendarDays, label: 'Today’s classes', question: 'What classes are on today?' },
  { icon: CalendarClock, label: 'Tomorrow', question: 'What classes are on tomorrow?' },
  { icon: ClipboardList, label: 'Upcoming exams', question: 'Show the upcoming exams' },
  { icon: UserRound, label: 'Who teaches AI?', question: 'Who is teaching AI?' },
];

// ---- Server status: say so up front if asking cannot work yet ----
const notice = ref(null); // 'offline' | 'no-ai' | 'no-data' | null
async function checkHealth() {
  try {
    const health = await getHealth();
    if (!health.ai_configured) notice.value = 'no-ai';
    else if (health.counts && !health.counts.timetable && !health.counts.exams) notice.value = 'no-data';
    else notice.value = null;
  } catch {
    notice.value = 'offline';
  }
}
onMounted(checkHealth);

// ---- Scrolling: follow the answer unless the reader has scrolled up ----
const scroller = ref(null);
const pinned = ref(true);
function onScroll() {
  const el = scroller.value;
  if (el) pinned.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}
function scrollToBottom(behavior = 'auto') {
  const el = scroller.value;
  if (el) el.scrollTo?.({ top: el.scrollHeight, behavior });
}
const lastMessage = computed(() => messages.value[messages.value.length - 1]);
watch(
  () => [messages.value.length, lastMessage.value?.text, lastMessage.value?.status],
  () => { if (pinned.value) nextTick(() => scrollToBottom()); },
);
// Opening another chat starts at its latest message
watch(activeId, () => {
  speech.stop();
  pinned.value = true;
  draft.value = '';
  nextTick(() => {
    scrollToBottom();
    composer.value?.focus();
  });
});
onMounted(() => nextTick(() => scrollToBottom()));

// ---- Actions ----
async function ask(question, { viaVoice = false } = {}) {
  speech.stop();
  pinned.value = true;
  const answer = await send(question);
  if (notice.value) checkHealth();
  // A spoken question gets a spoken answer
  if (viaVoice && answer?.status === 'done') speech.speak(answer.id, answerToText(answer));
}

function edit() {
  const text = takeLastQuestion();
  if (!text) return;
  draft.value = text;
  composer.value?.focus();
}

function startNew() {
  newChat();
  draft.value = '';
  composer.value?.focus();
}

// ---- Export ----
function saveAsText() {
  if (!active.value) return;
  const text = conversationToText(active.value, { student: user.value?.mat_number || '' });
  downloadText(`${fileNameFrom(active.value.title, 'utg-chat')}.txt`, text);
}
function printChat() {
  window.print();
}
</script>

<template>
  <div class="flex h-full print:block print:h-auto">
    <!-- Sidebar: a fixed column on wide screens, a drawer on phones -->
    <aside class="hidden w-64 shrink-0 border-r md:block print:hidden">
      <AppSidebar />
    </aside>
    <Sheet v-model:open="drawerOpen">
      <SheetContent side="left" class="w-72 gap-0 p-0" :show-close-button="false">
        <SheetTitle class="sr-only">Menu</SheetTitle>
        <SheetDescription class="sr-only">New chat, your recent chats and your account.</SheetDescription>
        <AppSidebar @navigate="drawerOpen = false" />
      </SheetContent>
    </Sheet>

    <section class="flex min-w-0 flex-1 flex-col print:block">
      <!-- Top bar -->
      <header class="flex h-14 shrink-0 items-center gap-1 px-2 sm:px-4 print:hidden">
        <Button variant="ghost" size="icon" class="md:hidden" aria-label="Open menu" @click="drawerOpen = true">
          <Menu />
        </Button>
        <p class="min-w-0 flex-1 truncate px-1 text-sm font-medium" :class="{ 'text-muted-foreground': empty }">
          {{ active?.title || 'New chat' }}
        </p>
        <DropdownMenu v-if="!empty">
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" size="sm" class="text-muted-foreground">
              <Download aria-hidden="true" />
              Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-52">
            <DropdownMenuItem @select="saveAsText"><FileText aria-hidden="true" /> Download as text</DropdownMenuItem>
            <DropdownMenuItem @select="printChat"><Printer aria-hidden="true" /> Print or save as PDF</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button variant="ghost" size="icon" class="md:hidden" aria-label="New chat" @click="startNew">
          <SquarePen />
        </Button>
      </header>

      <!-- Conversation -->
      <div
        v-if="!empty"
        ref="scroller"
        class="relative min-h-0 flex-1 overflow-y-auto print:overflow-visible"
        @scroll.passive="onScroll"
      >
        <div class="mx-auto w-full max-w-3xl px-4 pt-2 pb-4 sm:pb-6">
          <h1 class="mb-4 hidden text-lg font-semibold print:block">{{ active?.title }}</h1>
          <ol class="flex flex-col gap-4" aria-label="Conversation">
            <ChatMessage
              v-for="(m, i) in messages"
              :key="m.id"
              :message="m"
              :is-last-exchange="i >= lastUserIndex"
              :busy="busy"
              @retry="retry"
              @edit="edit"
              @reply="ask"
            />
          </ol>
          <!-- Announce finished answers to screen readers without re-reading every token -->
          <p class="sr-only" aria-live="polite">
            {{ lastMessage?.role === 'assistant' && lastMessage.status === 'done' ? 'Answer ready.' : '' }}
          </p>
        </div>
      </div>

      <!-- New chat: the question box sits in the middle of the screen -->
      <div v-else class="flex min-h-0 flex-[1_1_0] flex-col justify-end overflow-y-auto px-4">
        <div class="mx-auto w-full max-w-2xl">
          <Alert v-if="notice === 'offline'" variant="destructive" class="mb-6">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>Can’t reach the server</AlertTitle>
            <AlertDescription>
              The assistant’s API at {{ API_BASE }} is not responding. Start it, then
              <button type="button" class="font-medium underline underline-offset-4" @click="checkHealth">check again</button>.
            </AlertDescription>
          </Alert>
          <Alert v-else-if="notice === 'no-ai'" class="mb-6">
            <Info aria-hidden="true" />
            <AlertTitle>The AI model is not set up yet</AlertTitle>
            <AlertDescription>Add GROQ_API_KEY to server/.env and restart the server to get answers.</AlertDescription>
          </Alert>
          <Alert v-else-if="notice === 'no-data'" class="mb-6">
            <Info aria-hidden="true" />
            <AlertTitle>No timetable loaded yet</AlertTitle>
            <AlertDescription>
              There is nothing to answer from until a timetable file is uploaded in
              <RouterLink to="/admin" class="font-medium underline underline-offset-4">Admin</RouterLink>.
            </AlertDescription>
          </Alert>
          <h1 class="pb-6 text-center text-2xl font-semibold tracking-tight text-balance sm:pb-8 sm:text-3xl">
            What do you want to know?
          </h1>
        </div>
      </div>

      <!-- Question box: centered on a new chat, docked at the bottom otherwise -->
      <div class="relative shrink-0 print:hidden">
        <Button
          v-if="!pinned && !empty"
          variant="outline"
          size="icon"
          class="absolute -top-11 left-1/2 -translate-x-1/2 rounded-full shadow-md"
          aria-label="Scroll to latest message"
          @click="scrollToBottom('smooth')"
        >
          <ArrowDown />
        </Button>
        <div
          class="mx-auto w-full px-3 pt-1 sm:px-4"
          :class="empty ? 'max-w-2xl' : 'max-w-3xl pb-[max(0.75rem,env(safe-area-inset-bottom))]'"
        >
          <ChatComposer
            ref="composer"
            v-model="draft"
            v-model:streaming="streaming"
            class="relative z-10"
            :busy="busy"
            :roomy="empty"
            :show-hint="!empty"
            @send="ask"
            @stop="stop"
          />
          <ul
            v-if="empty"
            class="-mt-4 flex flex-wrap gap-x-1 gap-y-0.5 rounded-b-2xl bg-muted/60 px-2 pt-6 pb-2"
            aria-label="Quick questions"
          >
            <li v-for="s in shortcuts" :key="s.question">
              <Button variant="ghost" size="sm" class="text-muted-foreground" :disabled="busy" @click="ask(s.question)">
                <component :is="s.icon" aria-hidden="true" />
                {{ s.label }}
              </Button>
            </li>
          </ul>
        </div>
      </div>
      <div v-if="empty" class="flex-[1.6_1_0] print:hidden" aria-hidden="true" />
    </section>
  </div>
</template>
