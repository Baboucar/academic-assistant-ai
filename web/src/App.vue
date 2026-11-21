<script setup>
import { onMounted, watch } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import AppHeader from '@/components/AppHeader.vue';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useAuth } from '@/composables/useAuth';
import { useTheme } from '@/composables/useTheme';
import 'vue-sonner/style.css';

const { mode } = useTheme();
const route = useRoute();
const router = useRouter();
const { isSignedIn, restore } = useAuth();

// Confirm a saved session with the server, and leave the chat as soon as it ends
// (signed out, expired, or the password was reset on another device).
onMounted(restore);
watch(isSignedIn, (signedIn) => {
  if (!signedIn && route.meta.requiresStudent) router.replace({ name: 'login' });
});
</script>

<template>
  <TooltipProvider :delay-duration="300">
    <div class="flex h-full flex-col print:block print:h-auto">
      <a
        href="#main"
        class="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:ring-2 focus:ring-ring"
      >
        Skip to content
      </a>
      <AppHeader v-if="!route.meta.bare" />
      <main id="main" class="min-h-0 flex-1 print:h-auto">
        <RouterView />
      </main>
    </div>
    <Toaster :theme="mode === 'dark' ? 'dark' : 'light'" position="top-center" />
  </TooltipProvider>
</template>
