<script setup>
import { ref } from 'vue';
import { Ellipsis, FileSpreadsheet, FileText, FileType, LoaderCircle, RefreshCw, Trash2, DatabaseZap } from '@lucide/vue';
import { toast } from 'vue-sonner';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useAdmin } from '@/composables/useAdmin';
import { fullDate, plural, timeAgo } from '@/lib/format';

const { sources, loading, remove, reingest } = useAdmin();

const TYPE_LABELS = { timetable: 'Timetable', exams: 'Exams', calendar: 'Calendar', notices: 'Notice' };

function iconFor(name) {
  if (/\.xlsx?$/i.test(name)) return FileSpreadsheet;
  if (/\.docx$/i.test(name)) return FileType;
  return FileText;
}

// One action at a time per file, shown as a spinner on that row
const working = ref('');

async function doReingest(file) {
  if (working.value) return;
  working.value = file;
  try {
    await reingest(file);
    const row = sources.value.find((s) => s.source_file === file);
    toast.success(`Re-ingested ${file}`, { description: row ? plural(row.row_count, 'row') + ' loaded.' : undefined });
  } catch (e) {
    toast.error(`Could not re-ingest ${file}`, { description: e?.message, duration: 10000 });
  } finally {
    working.value = '';
  }
}

// Deleting asks first. `pending` is the row and whether the file goes too.
const pending = ref(null);
const dialogOpen = ref(false);

function askDelete(source, withFile) {
  pending.value = { source, withFile };
  dialogOpen.value = true;
}

async function confirmDelete() {
  const { source, withFile } = pending.value;
  const file = source.source_file;
  dialogOpen.value = false;
  working.value = file;
  try {
    const result = await remove(file, withFile);
    toast.success(withFile ? `Deleted ${file}` : `Removed ${file} from answers`, {
      description: `${plural(result.removed_rows, 'row')} removed.${withFile ? '' : ' The file is still in the data folder.'}`,
    });
  } catch (e) {
    toast.error(`Could not delete ${file}`, { description: e?.message });
  } finally {
    working.value = '';
  }
}
</script>

<template>
  <Card :class="{ 'pb-0': sources.length }">
    <CardHeader>
      <CardTitle class="text-base">Sources</CardTitle>
      <CardDescription>Every file the assistant can answer from, newest first.</CardDescription>
    </CardHeader>
    <CardContent class="px-0">
      <div v-if="loading && !sources.length" class="grid gap-3 px-4" aria-busy="true" aria-label="Loading sources">
        <Skeleton v-for="n in 3" :key="n" class="h-10 w-full" />
      </div>

      <div v-else-if="!sources.length" class="flex flex-col items-center gap-2 px-4 py-10 text-center">
        <span class="flex size-10 items-center justify-center rounded-full bg-muted text-muted-foreground" aria-hidden="true">
          <FileText class="size-5" />
        </span>
        <p class="text-sm font-medium">No files yet</p>
        <p class="max-w-xs text-sm text-muted-foreground">Upload a timetable to give the assistant something to answer from.</p>
      </div>

      <Table v-else>
        <TableHeader>
          <TableRow class="hover:bg-transparent">
            <TableHead class="pl-4">File</TableHead>
            <TableHead class="hidden sm:table-cell">Type</TableHead>
            <TableHead class="hidden md:table-cell">Semester</TableHead>
            <TableHead class="text-right">Rows</TableHead>
            <TableHead class="hidden md:table-cell">Ingested</TableHead>
            <TableHead class="w-12 pr-4"><span class="sr-only">Actions</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow v-for="s in sources" :key="s.source_file">
            <TableCell class="pl-4">
              <div class="flex items-center gap-2.5">
                <component :is="iconFor(s.source_file)" class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div class="min-w-0 whitespace-normal">
                  <div class="font-medium [overflow-wrap:anywhere]">{{ s.source_file }}</div>
                  <!-- Small screens fold the hidden columns under the file name -->
                  <div class="text-xs text-muted-foreground md:hidden">
                    <span class="sm:hidden">{{ TYPE_LABELS[s.type] || s.type }} · </span>{{ s.semester ? `${s.semester} · ` : '' }}{{ timeAgo(s.ingested_at) }}
                  </div>
                  <div v-if="s.dept" class="text-xs text-muted-foreground">Department: {{ s.dept }}</div>
                </div>
              </div>
            </TableCell>
            <TableCell class="hidden sm:table-cell"><Badge variant="secondary">{{ TYPE_LABELS[s.type] || s.type }}</Badge></TableCell>
            <TableCell class="hidden text-muted-foreground md:table-cell">{{ s.semester || '—' }}</TableCell>
            <TableCell class="text-right tabular-nums">
              <span v-if="s.row_count > 0">{{ s.row_count }}</span>
              <Tooltip v-else>
                <TooltipTrigger as-child>
                  <Badge variant="destructive" tabindex="0">0</Badge>
                </TooltipTrigger>
                <TooltipContent>Nothing was read from this file. Check its format, then re-ingest.</TooltipContent>
              </Tooltip>
            </TableCell>
            <TableCell class="hidden text-muted-foreground md:table-cell" :title="fullDate(s.ingested_at)">{{ timeAgo(s.ingested_at) }}</TableCell>
            <TableCell class="pr-4 text-right">
              <LoaderCircle v-if="working === s.source_file" class="ml-auto size-4 animate-spin text-muted-foreground" role="status" aria-label="Working" />
              <DropdownMenu v-else>
                <DropdownMenuTrigger as-child>
                  <Button variant="ghost" size="icon-sm" :aria-label="`Actions for ${s.source_file}`" :disabled="!!working">
                    <Ellipsis />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" class="w-56">
                  <DropdownMenuItem @select="doReingest(s.source_file)">
                    <RefreshCw aria-hidden="true" /> Re-ingest
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem @select="askDelete(s, false)">
                    <DatabaseZap aria-hidden="true" /> Remove from answers…
                  </DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" @select="askDelete(s, true)">
                    <Trash2 aria-hidden="true" /> Delete file…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </CardContent>
  </Card>

  <AlertDialog v-model:open="dialogOpen">
    <AlertDialogContent v-if="pending">
      <AlertDialogHeader>
        <AlertDialogTitle>
          {{ pending.withFile ? 'Delete this file?' : 'Remove this file from answers?' }}
        </AlertDialogTitle>
        <AlertDialogDescription>
          <span class="break-all font-medium text-foreground">{{ pending.source.source_file }}</span>
          <template v-if="pending.withFile">
            and its {{ plural(pending.source.row_count, 'row') }} will be deleted from the server. This cannot be undone.
          </template>
          <template v-else>
            will stop being used in answers ({{ plural(pending.source.row_count, 'row') }}). The file stays in the data
            folder and comes back the next time everything is re-ingested.
          </template>
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction :variant="pending.withFile ? 'destructive' : 'default'" @click="confirmDelete">
          {{ pending.withFile ? 'Delete file' : 'Remove' }}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
