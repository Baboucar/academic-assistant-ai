<script setup>
// Left rail of the chat screen: new chat, the student's recent chats, and the account menu.
import { computed } from 'vue';
import { RouterLink, useRouter } from 'vue-router';
import { ChevronsUpDown, GraduationCap, LogOut, Monitor, Moon, ShieldCheck, SquarePen, Sun, Trash2 } from '@lucide/vue';
import { toast } from 'vue-sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useAuth } from '@/composables/useAuth';
import { useChat } from '@/composables/useChat';
import { useTheme } from '@/composables/useTheme';

// "navigate" fires after anything that should close the sidebar when it is shown as a drawer
const emit = defineEmits(['navigate']);

const router = useRouter();
const { user, signOut } = useAuth();
const { conversations, activeId, newChat, openChat, deleteChat } = useChat();
const { choice } = useTheme();

const initial = computed(() => (user.value?.email || user.value?.mat_number || '?').charAt(0).toUpperCase());

function startNew() {
  newChat();
  emit('navigate');
}

function open(id) {
  openChat(id);
  emit('navigate');
}

function remove(conversation) {
  const undo = deleteChat(conversation.id);
  toast('Chat deleted', {
    description: conversation.title,
    action: { label: 'Undo', onClick: undo },
  });
}

async function leave() {
  await signOut();
  emit('navigate');
  router.replace({ name: 'login' });
}
</script>

<template>
  <div class="flex h-full flex-col bg-sidebar text-sidebar-foreground">
    <div class="flex h-14 shrink-0 items-center gap-2.5 px-4">
      <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground" aria-hidden="true">
        <GraduationCap class="size-[18px]" />
      </span>
      <span class="truncate text-sm font-semibold tracking-tight">UTG Assistant</span>
    </div>

    <div class="px-2">
      <Button variant="ghost" class="w-full justify-start gap-2.5 px-2.5" @click="startNew">
        <SquarePen aria-hidden="true" />
        New chat
      </Button>
    </div>

    <nav class="mt-4 flex min-h-0 flex-1 flex-col" aria-label="Recent chats">
      <h2 class="px-4 pb-1.5 text-xs font-medium text-muted-foreground">Recents</h2>
      <p v-if="!conversations.length" class="px-4 py-1 text-sm text-muted-foreground">
        Your chats will show up here.
      </p>
      <ul v-else class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <li v-for="c in conversations" :key="c.id" class="group/chat relative">
          <button
            type="button"
            class="block w-full truncate rounded-md py-1.5 pr-8 pl-2.5 text-left text-sm outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50"
            :class="c.id === activeId ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground' : 'text-sidebar-foreground/80'"
            :aria-current="c.id === activeId ? 'page' : undefined"
            :title="c.title"
            @click="open(c.id)"
          >
            {{ c.title }}
          </button>
          <Button
            variant="ghost"
            size="icon-xs"
            class="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground opacity-100 hover:text-destructive sm:opacity-0 sm:group-focus-within/chat:opacity-100 sm:group-hover/chat:opacity-100"
            :aria-label="`Delete chat: ${c.title}`"
            @click="remove(c)"
          >
            <Trash2 />
          </Button>
        </li>
      </ul>
    </nav>

    <div class="shrink-0 border-t p-2">
      <DropdownMenu>
        <DropdownMenuTrigger as-child>
          <button
            type="button"
            class="flex w-full items-center gap-2.5 rounded-md p-1.5 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50"
            aria-label="Account menu"
          >
            <span class="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary" aria-hidden="true">
              {{ initial }}
            </span>
            <span class="min-w-0 flex-1 leading-tight">
              <span class="block truncate text-sm font-medium">{{ user?.mat_number }}</span>
              <span class="block truncate text-xs text-muted-foreground">{{ user?.email }}</span>
            </span>
            <ChevronsUpDown class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" class="w-56">
          <DropdownMenuLabel>Theme</DropdownMenuLabel>
          <DropdownMenuRadioGroup v-model="choice">
            <DropdownMenuRadioItem value="light"><Sun aria-hidden="true" /> Light</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="dark"><Moon aria-hidden="true" /> Dark</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="auto"><Monitor aria-hidden="true" /> System</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem as-child>
            <RouterLink to="/admin"><ShieldCheck aria-hidden="true" /> Admin</RouterLink>
          </DropdownMenuItem>
          <DropdownMenuItem @select="leave"><LogOut aria-hidden="true" /> Sign out</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  </div>
</template>
