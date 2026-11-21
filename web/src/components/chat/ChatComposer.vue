<script setup>
import { computed, nextTick, ref } from 'vue';
import { ArrowUp, Mic, Square } from '@lucide/vue';
import { toast } from 'vue-sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useSpeechRecognition } from '@/composables/useSpeech';

const MAX_LENGTH = 500;

const props = defineProps({
  busy: { type: Boolean, default: false },
  // taller box for the centered new-chat screen
  roomy: { type: Boolean, default: false },
  showHint: { type: Boolean, default: true },
});
const emit = defineEmits(['send', 'stop']);
const text = defineModel({ type: String, default: '' });
const streaming = defineModel('streaming', { type: Boolean, default: true });

const inputEl = ref(null);
const canSend = computed(() => text.value.trim().length > 0 && !props.busy);
const nearLimit = computed(() => text.value.length > MAX_LENGTH - 60);

function submit({ viaVoice = false } = {}) {
  if (!canSend.value) return;
  emit('send', text.value.trim(), { viaVoice });
  text.value = '';
}

function onKeydown(e) {
  // Enter sends; Shift+Enter is a new line. Leave Enter alone while an IME is composing.
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submit();
  }
}

const voice = useSpeechRecognition({
  onResult: (heard) => { text.value = heard.slice(0, MAX_LENGTH); },
  // The speaker paused on their own: send it, hands-free
  onFinal: () => submit({ viaVoice: true }),
  onError: (message) => toast.error(message),
});

function toggleVoice() {
  if (voice.listening.value) {
    // Tapping the mic again keeps the words in the box so they can be fixed first
    voice.stop();
    focus();
  } else {
    text.value = '';
    voice.start();
  }
}

function focus() {
  nextTick(() => {
    const el = inputEl.value;
    if (!el) return;
    el.focus();
    el.setSelectionRange?.(el.value.length, el.value.length);
  });
}
defineExpose({ focus });
</script>

<template>
  <form @submit.prevent="submit()">
    <div
      class="rounded-2xl border bg-card shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50"
    >
      <label for="question" class="sr-only">Your question</label>
      <textarea
        id="question"
        ref="inputEl"
        v-model="text"
        rows="1"
        :maxlength="MAX_LENGTH"
        :placeholder="voice.listening.value ? 'Listening…' : 'Ask about a course, lecturer, venue, day or exam'"
        class="field-sizing-content block max-h-40 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-base outline-none placeholder:text-muted-foreground md:text-[0.9375rem]"
        :class="roomy ? 'min-h-20' : 'min-h-11'"
        enterkeyhint="send"
        @keydown="onKeydown"
      />
      <div class="flex items-center gap-2 px-2 pb-2">
        <Tooltip v-if="voice.supported">
          <TooltipTrigger as-child>
            <Button
              type="button"
              :variant="voice.listening.value ? 'destructive' : 'ghost'"
              size="icon"
              class="rounded-full"
              :class="voice.listening.value ? 'animate-pulse' : 'text-muted-foreground'"
              :aria-label="voice.listening.value ? 'Stop listening' : 'Ask by voice'"
              :aria-pressed="voice.listening.value"
              :disabled="busy"
              @click="toggleVoice"
            >
              <Mic />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{{ voice.listening.value ? 'Stop listening' : 'Ask by voice' }}</TooltipContent>
        </Tooltip>

        <div class="flex items-center gap-2 pl-1.5">
          <Switch id="streaming" v-model="streaming" size="sm" />
          <Label for="streaming" class="text-xs font-normal text-muted-foreground">Live answers</Label>
        </div>

        <span v-if="nearLimit" class="ml-auto text-xs tabular-nums text-muted-foreground" aria-live="polite">
          {{ text.length }}/{{ MAX_LENGTH }}
        </span>

        <Button
          v-if="busy"
          type="button"
          size="icon"
          class="rounded-full"
          :class="{ 'ml-auto': !nearLimit }"
          aria-label="Stop answering"
          @click="emit('stop')"
        >
          <Square class="fill-current" />
        </Button>
        <Button
          v-else
          type="submit"
          size="icon"
          class="rounded-full"
          :class="{ 'ml-auto': !nearLimit }"
          aria-label="Send question"
          :disabled="!canSend"
        >
          <ArrowUp />
        </Button>
      </div>
    </div>
    <p v-if="showHint" class="mt-2 hidden text-center text-xs text-muted-foreground sm:block">
      Answers come only from the uploaded timetables. Enter to send, Shift+Enter for a new line.
    </p>
  </form>
</template>
