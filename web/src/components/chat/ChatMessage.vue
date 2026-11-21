<script setup>
import { computed, onBeforeUnmount, ref } from 'vue';
import { Check, CircleAlert, Copy, GraduationCap, Pencil, RotateCcw, Square, Volume2 } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import SourcesPanel from './SourcesPanel.vue';
import { useSpeechSynthesis } from '@/composables/useSpeech';
import { answerToText } from '@/lib/export';
import { mdToHtml } from '@/lib/markdown';

const props = defineProps({
  message: { type: Object, required: true },
  // the last question / answer get Edit and Retry
  isLastExchange: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
});
// "reply" answers a question the assistant asked (for example which department)
const emit = defineEmits(['retry', 'edit', 'reply']);

const isUser = computed(() => props.message.role === 'user');
const status = computed(() => props.message.status);
const html = computed(() => mdToHtml(props.message.text));
const working = computed(() => status.value === 'pending' || status.value === 'streaming');

const speech = useSpeechSynthesis();
const speaking = computed(() => speech.speakingId.value === props.message.id);

const copied = ref(false);
let copiedTimer;
async function copy() {
  try {
    await navigator.clipboard.writeText(isUser.value ? props.message.text : answerToText(props.message));
    copied.value = true;
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => { copied.value = false; }, 1500);
  } catch {
    // clipboard blocked (insecure origin or denied): nothing useful to show
  }
}
onBeforeUnmount(() => {
  clearTimeout(copiedTimer);
  if (speaking.value) speech.stop();
});
</script>

<template>
  <!-- Question -->
  <li v-if="isUser" class="group/msg flex flex-col items-end" data-role="user">
    <span class="sr-only">You asked:</span>
    <div class="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-[0.9375rem] leading-relaxed text-primary-foreground">
      {{ message.text }}
    </div>
    <div class="mt-1 flex gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within/msg:opacity-100 sm:group-hover/msg:opacity-100">
      <Tooltip>
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon-xs" class="text-muted-foreground" :aria-label="copied ? 'Copied' : 'Copy question'" @click="copy">
            <Check v-if="copied" /><Copy v-else />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{{ copied ? 'Copied' : 'Copy' }}</TooltipContent>
      </Tooltip>
      <Tooltip v-if="isLastExchange">
        <TooltipTrigger as-child>
          <Button variant="ghost" size="icon-xs" class="text-muted-foreground" aria-label="Edit question" :disabled="busy" @click="emit('edit')">
            <Pencil />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">Edit</TooltipContent>
      </Tooltip>
    </div>
  </li>

  <!-- Answer -->
  <li v-else class="flex gap-3" data-role="assistant">
    <span class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full border bg-muted text-muted-foreground" aria-hidden="true">
      <GraduationCap class="size-4" />
    </span>
    <div class="min-w-0 flex-1">
      <span class="sr-only">Assistant answered:</span>

      <div v-if="status === 'pending'" class="flex h-7 items-center gap-2 text-sm text-muted-foreground" role="status">
        <span class="flex gap-1" aria-hidden="true">
          <span class="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.3s]" />
          <span class="size-1.5 animate-bounce rounded-full bg-current [animation-delay:-0.15s]" />
          <span class="size-1.5 animate-bounce rounded-full bg-current" />
        </span>
        Checking the timetable…
      </div>

      <div
        v-if="message.text"
        class="prose-chat pt-0.5 text-[0.9375rem]"
        :class="{ 'streaming-caret': status === 'streaming' }"
        :aria-busy="status === 'streaming'"
        v-html="html"
      />

      <p v-if="message.degraded && status === 'done'" class="mt-2 text-xs text-muted-foreground" data-testid="degraded-note">
        The AI model was busy, so this was read straight from the timetable. Ask again in a moment if it missed the point.
      </p>

      <p v-if="status === 'stopped'" class="text-sm text-muted-foreground" :class="message.text ? 'mt-2' : 'pt-1'">
        {{ message.text ? 'Stopped before the answer finished.' : 'Stopped.' }}
      </p>

      <div
        v-if="status === 'error'"
        class="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        :class="{ 'mt-2': message.text }"
        role="alert"
      >
        <CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span class="min-w-0 flex-1">{{ message.error }}</span>
      </div>

      <ul
        v-if="message.choices?.length && isLastExchange && status === 'done'"
        class="mt-3 flex flex-wrap gap-2"
        aria-label="Choose one"
      >
        <li v-for="choice in message.choices" :key="choice">
          <Button variant="outline" size="sm" class="rounded-full" :disabled="busy" @click="emit('reply', choice)">
            {{ choice }}
          </Button>
        </li>
      </ul>

      <SourcesPanel
        v-if="message.sources?.length && !working"
        :sources="message.sources"
        :filters="message.filters"
        :expanded="message.schedule"
      />

      <div v-if="!working" class="-ml-1.5 mt-1.5 flex gap-0.5">
        <Tooltip v-if="message.text">
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon-xs" class="text-muted-foreground" :aria-label="copied ? 'Copied' : 'Copy answer'" @click="copy">
              <Check v-if="copied" /><Copy v-else />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{{ copied ? 'Copied' : 'Copy' }}</TooltipContent>
        </Tooltip>
        <Tooltip v-if="message.text && speech.supported">
          <TooltipTrigger as-child>
            <Button
              variant="ghost"
              size="icon-xs"
              :class="speaking ? 'text-foreground' : 'text-muted-foreground'"
              :aria-label="speaking ? 'Stop reading' : 'Read aloud'"
              :aria-pressed="speaking"
              @click="speech.toggle(message.id, answerToText(message))"
            >
              <Square v-if="speaking" class="fill-current" /><Volume2 v-else />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{{ speaking ? 'Stop reading' : 'Read aloud' }}</TooltipContent>
        </Tooltip>
        <Tooltip v-if="isLastExchange">
          <TooltipTrigger as-child>
            <Button variant="ghost" size="icon-xs" class="text-muted-foreground" aria-label="Try again" :disabled="busy" @click="emit('retry')">
              <RotateCcw />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Try again</TooltipContent>
        </Tooltip>
      </div>
    </div>
  </li>
</template>
