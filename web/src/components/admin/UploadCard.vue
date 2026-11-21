<script setup>
import { computed, ref, watch } from 'vue';
import { FileText, LoaderCircle, Upload, X } from '@lucide/vue';
import { toast } from 'vue-sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useAdmin } from '@/composables/useAdmin';
import { fileSize, plural } from '@/lib/format';

const MAX_BYTES = 25 * 1024 * 1024;
// What each kind of file can be read as (mirrors the server)
const TYPES_BY_EXT = {
  pdf: ['timetable', 'exams', 'calendar'],
  xlsx: ['timetable', 'exams'],
  xls: ['timetable', 'exams'],
  docx: ['notices'],
};
const TYPE_LABELS = { timetable: 'Class timetable', exams: 'Exam timetable', calendar: 'Academic calendar', notices: 'Notice' };

const { upload } = useAdmin();

const file = ref(null);
const type = ref('timetable');
const semester = ref('');
// Which department or school the file belongs to (class and exam timetables)
const dept = ref('');
const hasDept = computed(() => type.value === 'timetable' || type.value === 'exams');
const ingestNow = ref(true);
const uploading = ref(false);
const dragging = ref(false);
const error = ref('');
// What the reader made of the last upload: { file, rows, notes }
const lastResult = ref(null);
const picker = ref(null);

const extension = computed(() => file.value?.name.split('.').pop()?.toLowerCase() || '');
const allowedTypes = computed(() => TYPES_BY_EXT[extension.value] || Object.keys(TYPE_LABELS));

// Keep the type valid for the chosen file; guess "calendar" or "exams" from the name like the ingest does
watch(file, (f) => {
  // an offer to replace anyway belongs to the file that was refused, not to the next one chosen
  if (lastResult.value?.refused && f !== lastResult.value.upload) lastResult.value = null;
  if (!f) return;
  const allowed = allowedTypes.value;
  if (allowed.includes('calendar') && /calendar/i.test(f.name)) type.value = 'calendar';
  else if (allowed.includes('exams') && /exam/i.test(f.name)) type.value = 'exams';
  // otherwise start from the usual type, not whatever the previous file was
  else type.value = allowed.includes('timetable') ? 'timetable' : allowed[0];
});

function choose(f) {
  error.value = '';
  if (!f) return;
  const ext = f.name.split('.').pop()?.toLowerCase();
  if (!TYPES_BY_EXT[ext]) {
    error.value = 'That file type is not supported. Use a PDF, Excel (.xlsx, .xls) or Word (.docx) file.';
    return;
  }
  if (f.size > MAX_BYTES) {
    error.value = `That file is ${fileSize(f.size)}. The limit is 25 MB.`;
    return;
  }
  file.value = f;
}

function onPick(e) {
  choose(e.target.files?.[0]);
  e.target.value = ''; // allow picking the same file again
}

function onDrop(e) {
  dragging.value = false;
  choose(e.dataTransfer?.files?.[0]);
}

async function submit(event, { force = false } = {}) {
  if (!file.value || uploading.value) return;
  uploading.value = true;
  error.value = '';
  lastResult.value = null;
  try {
    const result = await upload(file.value, {
      type: type.value,
      semester: semester.value.trim(),
      dept: hasDept.value ? dept.value.trim() : '',
      reingest: ingestNow.value,
      force,
    });
    if (result.kept_previous) {
      // The new version read (almost) nothing, so the server kept the old one.
      // The file stays selected so it can be sent again with "Replace anyway".
      const why = (result.ingest?.log || '').split('\n').find((l) => l.startsWith('Refused:'));
      const reason = (why || '').replace(/^Refused:\s*\S+\s*->\s*/, '');
      lastResult.value = {
        file: result.file,
        rows: result.rows ?? null,
        notes: [],
        // a full sentence either way
        refused: reason ? `The server ${reason}` : 'The new version could not be read, so the one already loaded was kept.',
        // "Replace anyway" is only offered when the server would accept it, and only for this very file
        canForce: Boolean(reason),
        upload: file.value,
      };
      toast.warning(`${result.file} was not replaced`, { description: 'The version already loaded was kept. See the note under the form.', duration: 10000 });
      return;
    }
    if (result.ingest && !result.ingest.ok) {
      toast.error(`Uploaded ${result.file}, but it could not be read`, {
        description: result.ingest.log?.split('\n').find((l) => /fail|error/i.test(l)) || 'Check the file format and try re-ingesting.',
        duration: 10000,
      });
    } else if (result.ingest) {
      // The ingest log says how many rows were read ("-> +73") and lists anything
      // the reader corrected or could not place ("note: ...")
      const log = result.ingest.log || '';
      const count = log.match(/->\s*\+(\d+)/);
      const rows = count ? Number(count[1]) : null;
      const notes = log.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('note:')).map((l) => l.slice(5).trim());
      lastResult.value = { file: result.file, rows, notes };
      if (rows === 0) {
        toast.warning(`Uploaded ${result.file}, but nothing could be read from it`, {
          description: 'Check that the type matches the file and that its layout is supported.',
          duration: 10000,
        });
      } else {
        toast.success(`Uploaded and ingested ${result.file}`);
      }
    } else {
      toast.success(`Uploaded ${result.file}`, { description: 'Re-ingest it when you want it used in answers.' });
    }
    file.value = null;
  } catch (e) {
    error.value = e?.message || 'Upload failed. Please try again.';
  } finally {
    uploading.value = false;
  }
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="text-base">Upload a file</CardTitle>
      <CardDescription>PDF, Excel or Word, up to 25 MB. A file with the same name replaces the old one.</CardDescription>
    </CardHeader>
    <CardContent>
      <form class="grid gap-4 md:grid-cols-2 md:gap-6" @submit.prevent="submit">
        <input ref="picker" type="file" class="sr-only" tabindex="-1" aria-hidden="true" accept=".pdf,.xlsx,.xls,.docx" @change="onPick" />

        <div class="grid content-start gap-3">
        <div
          v-if="!file"
          class="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed px-4 py-8 text-center transition-colors md:min-h-36"
          :class="dragging ? 'border-ring bg-muted' : 'bg-muted/30'"
          @dragover.prevent="dragging = true"
          @dragleave.prevent="dragging = false"
          @drop.prevent="onDrop"
        >
          <span class="flex size-9 items-center justify-center rounded-full border bg-background text-muted-foreground" aria-hidden="true">
            <Upload class="size-4" />
          </span>
          <p class="text-sm">
            <span class="hidden sm:inline">Drag a file here or </span>
            <button
              type="button"
              class="rounded-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              @click="picker?.click()"
            >
              <span class="sm:hidden">Choose a file</span><span class="hidden sm:inline">choose one</span>
            </button>
          </p>
          <p class="text-xs text-muted-foreground">.pdf, .xlsx, .xls, .docx</p>
        </div>

        <div v-else class="flex items-center gap-3 rounded-xl border bg-muted/30 px-3 py-2.5">
          <FileText class="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium">{{ file.name }}</p>
            <p class="text-xs text-muted-foreground">{{ fileSize(file.size) }}</p>
          </div>
          <Button type="button" variant="ghost" size="icon-sm" aria-label="Remove selected file" :disabled="uploading" @click="file = null">
            <X />
          </Button>
        </div>

        <p v-if="error" class="text-sm text-destructive" role="alert">{{ error }}</p>

        <div
          v-if="lastResult"
          class="rounded-lg border px-3 py-2.5 text-sm"
          :class="lastResult.rows === 0 || lastResult.refused ? 'border-destructive/40 bg-destructive/5' : 'bg-muted/40'"
          role="status"
          data-testid="upload-result"
        >
          <template v-if="lastResult.refused">
            <p class="font-medium [overflow-wrap:anywhere]">{{ lastResult.file }} was not replaced</p>
            <p class="mt-1 text-muted-foreground">{{ lastResult.refused }}</p>
            <Button
              v-if="lastResult.canForce"
              type="button" variant="outline" size="sm" class="mt-2.5"
              :disabled="uploading || file !== lastResult.upload"
              @click="submit(null, { force: true })"
            >
              Replace anyway
            </Button>
          </template>
          <p v-else class="font-medium [overflow-wrap:anywhere]">
            {{ lastResult.file }}:
            {{ lastResult.rows === null ? 'ingested' : lastResult.rows === 0 ? 'nothing could be read' : `${plural(lastResult.rows, 'row')} read` }}
          </p>
          <template v-if="lastResult.notes.length">
            <p class="mt-1.5 text-muted-foreground">The reader noted {{ plural(lastResult.notes.length, 'thing') }} to check against the file:</p>
            <ul class="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
              <li v-for="note in lastResult.notes" :key="note" class="[overflow-wrap:anywhere]">{{ note }}</li>
            </ul>
          </template>
        </div>
        </div>

        <div class="grid content-start gap-4">
        <div class="grid gap-4 sm:grid-cols-2">
          <div class="grid gap-1.5">
            <Label for="upload-type">This file is a</Label>
            <Select v-model="type">
              <SelectTrigger id="upload-type" class="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="t in allowedTypes" :key="t" :value="t">{{ TYPE_LABELS[t] }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div class="grid gap-1.5">
            <Label for="upload-semester">Semester <span class="font-normal text-muted-foreground">(optional)</span></Label>
            <Input id="upload-semester" v-model="semester" placeholder="2025-2026 S1" maxlength="60" />
          </div>
          <div v-if="hasDept" class="grid gap-1.5 sm:col-span-2">
            <Label for="upload-dept">Department or school <span class="font-normal text-muted-foreground">(optional)</span></Label>
            <Input
              id="upload-dept" v-model="dept" placeholder="CS, LAW, BUSINESS…" maxlength="20"
              autocapitalize="characters" spellcheck="false" aria-describedby="upload-dept-hint"
            />
            <p id="upload-dept-hint" class="text-xs text-muted-foreground">
              A short code. Students can ask for one department, and are asked which one when a question covers several.
            </p>
          </div>
        </div>

        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="flex items-center gap-2">
            <Switch id="ingest-now" v-model="ingestNow" />
            <Label for="ingest-now" class="font-normal">Ingest right after upload</Label>
          </div>
          <Button type="submit" :disabled="!file || uploading">
            <LoaderCircle v-if="uploading" class="animate-spin" aria-hidden="true" />
            <Upload v-else aria-hidden="true" />
            {{ uploading ? 'Uploading…' : 'Upload' }}
          </Button>
        </div>
        </div>
      </form>
    </CardContent>
  </Card>
</template>
