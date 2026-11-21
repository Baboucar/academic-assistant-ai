<script setup>
import { RouterLink, useRoute } from 'vue-router';
import { GraduationCap, MessageSquare, Monitor, Moon, ShieldCheck, Sun } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTheme } from '@/composables/useTheme';

const route = useRoute();
const { mode, choice } = useTheme();

const links = [
  { name: 'chat', to: '/', label: 'Chat', icon: MessageSquare },
  { name: 'admin', to: '/admin', label: 'Admin', icon: ShieldCheck },
];
</script>

<template>
  <header class="shrink-0 border-b bg-background">
    <div class="mx-auto flex h-14 w-full max-w-5xl items-center gap-2 px-3 sm:px-4">
      <RouterLink to="/" class="flex min-w-0 items-center gap-2.5 rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
        <span class="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <GraduationCap class="size-[18px]" aria-hidden="true" />
        </span>
        <span class="min-w-0 leading-tight">
          <span class="block truncate text-sm font-semibold tracking-tight">
            <span class="sm:hidden">UTG Assistant</span>
            <span class="hidden sm:inline">UTG Academic Assistant</span>
          </span>
          <span class="hidden text-xs text-muted-foreground sm:block">Timetables, lecturers and venues</span>
        </span>
      </RouterLink>

      <nav class="ml-auto flex items-center gap-1" aria-label="Main">
        <Button
          v-for="link in links"
          :key="link.name"
          as-child
          variant="ghost"
          size="sm"
          :class="route.name === link.name ? 'bg-muted text-foreground' : 'text-muted-foreground'"
        >
          <RouterLink :to="link.to" :aria-current="route.name === link.name ? 'page' : undefined">
            <component :is="link.icon" aria-hidden="true" />
            {{ link.label }}
          </RouterLink>
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger as-child>
            <Button variant="ghost" size="icon-sm" class="ml-1 text-muted-foreground" aria-label="Change theme">
              <Moon v-if="mode === 'dark'" aria-hidden="true" />
              <Sun v-else aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="w-36">
            <DropdownMenuLabel>Theme</DropdownMenuLabel>
            <DropdownMenuRadioGroup v-model="choice">
              <DropdownMenuRadioItem value="light"><Sun aria-hidden="true" /> Light</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="dark"><Moon aria-hidden="true" /> Dark</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="auto"><Monitor aria-hidden="true" /> System</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>
    </div>
  </header>
</template>
