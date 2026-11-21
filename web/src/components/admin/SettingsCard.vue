<script setup>
// Things an admin sets that change answers: which semester answers come from,
// and the other names courses go by.
import { computed, ref } from 'vue';
import { LoaderCircle, Plus, X } from '@lucide/vue';
import { toast } from 'vue-sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAdmin } from '@/composables/useAdmin';
import { plural } from '@/lib/format';

const { settings, aliases, setSemester, addAlias, removeAlias } = useAdmin();

const AUTOMATIC = '__automatic__';
const ALL = '*';
const choice = computed(() => settings.value?.current_semester || AUTOMATIC);
const semesters = computed(() => settings.value?.semesters || []);
// A pinned semester whose files have all been removed: still shown, so it can be seen and changed
const stalePin = computed(() => {
  const pinned = settings.value?.current_semester;
  return pinned && pinned !== ALL && !semesters.value.some((s) => s.semester === pinned) ? pinned : null;
});
const saving = ref(false);

async function pick(value) {
  if (saving.value || value === choice.value) return;
  saving.value = true;
  try {
    await setSemester(value === AUTOMATIC ? null : value);
    toast.success('Current semester updated');
  } catch (e) {
    toast.error('Could not change the semester', { description: e?.message });
  } finally {
    saving.value = false;
  }
}

const activeNote = computed(() => {
  const s = settings.value;
  if (!s) return '';
  if (s.current_semester === ALL) return 'Answers use every semester that is loaded.';
  if (stalePin.value) {
    return `Nothing is loaded for ${stalePin.value} any more, so it is being ignored${s.active_semester ? ` and answers use ${s.active_semester}` : ''}. Choose another.`;
  }
  if (s.active_semester) return `Answers use ${s.active_semester} only.`;
  return 'Only one semester is loaded, so there is nothing to choose yet.';
});

// ---- aliases ----
const alias = ref('');
const title = ref('');
const adding = ref(false);
const aliasError = ref('');

async function add() {
  if (adding.value) return;
  aliasError.value = '';
  const a = alias.value.trim();
  const t = title.value.trim();
  if (a.length < 2 || t.length < 2) {
    aliasError.value = 'Enter the short name and the full course title it stands for.';
    return;
  }
  adding.value = true;
  try {
    await addAlias(a, t);
    alias.value = '';
    title.value = '';
  } catch (e) {
    aliasError.value = e?.message || 'Could not add it. Please try again.';
  } finally {
    adding.value = false;
  }
}

async function drop(name) {
  try {
    await removeAlias(name);
  } catch (e) {
    toast.error('Could not remove it', { description: e?.message });
  }
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="text-base">Settings</CardTitle>
      <CardDescription>These change what students are told, straight away.</CardDescription>
    </CardHeader>
    <CardContent class="grid gap-6">
      <div class="grid gap-1.5">
        <Label for="current-semester">Current semester</Label>
        <Select :model-value="choice" :disabled="saving || !settings" @update:model-value="pick">
          <SelectTrigger id="current-semester" class="w-full sm:w-72">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem :value="AUTOMATIC">Automatic (the newest upload)</SelectItem>
            <SelectItem v-for="s in semesters" :key="s.semester" :value="s.semester">
              {{ s.semester }} · {{ plural(s.files, 'file') }}
            </SelectItem>
            <SelectItem v-if="stalePin" :value="stalePin">{{ stalePin }} · no files loaded</SelectItem>
            <SelectItem :value="ALL">All semesters together</SelectItem>
          </SelectContent>
        </Select>
        <p class="text-xs text-muted-foreground" data-testid="semester-note">
          {{ activeNote }} Set the semester on each file when you upload it.
        </p>
      </div>

      <div class="grid gap-2">
        <div>
          <h3 class="text-sm font-medium">Other names for courses</h3>
          <p class="text-xs text-muted-foreground">
            What students call a course, and its title in the timetable. Asking for either finds both.
          </p>
        </div>
        <ul v-if="aliases.length" class="divide-y rounded-lg border" aria-label="Course aliases">
          <li v-for="a in aliases" :key="a.alias" class="flex items-center gap-2 px-3 py-1.5 text-sm">
            <span class="min-w-0 flex-1 [overflow-wrap:anywhere]">
              <span class="font-medium">{{ a.alias }}</span>
              <span class="text-muted-foreground"> means </span>{{ a.title }}
            </span>
            <Button variant="ghost" size="icon-xs" class="text-muted-foreground hover:text-destructive" :aria-label="`Remove ${a.alias}`" @click="drop(a.alias)">
              <X />
            </Button>
          </li>
        </ul>
        <p v-else class="text-sm text-muted-foreground">None yet.</p>

        <form class="grid gap-2 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)_auto] sm:items-end" novalidate @submit.prevent="add">
          <div class="grid gap-1.5">
            <Label for="alias-name">Short name</Label>
            <Input id="alias-name" v-model="alias" placeholder="OS" maxlength="80" autocapitalize="characters" spellcheck="false" />
          </div>
          <div class="grid gap-1.5">
            <Label for="alias-title">Course title in the timetable</Label>
            <Input id="alias-title" v-model="title" placeholder="Operating Systems" maxlength="80" />
          </div>
          <Button type="submit" variant="outline" :disabled="adding">
            <LoaderCircle v-if="adding" class="animate-spin" aria-hidden="true" />
            <Plus v-else aria-hidden="true" />
            Add
          </Button>
        </form>
        <p v-if="aliasError" class="text-sm text-destructive" role="alert">{{ aliasError }}</p>
      </div>
    </CardContent>
  </Card>
</template>
