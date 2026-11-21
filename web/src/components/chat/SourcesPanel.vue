<script setup>
// The timetable rows behind an answer, drawn as a schedule grouped by day (or by
// date for exams). Short results stay tucked behind a button; longer ones are
// shown open, because the answer text only summarises them.
import { computed, ref } from 'vue';
import { CalendarPlus, ChevronRight, Sheet as SheetIcon, TableProperties } from '@lucide/vue';
import { toast } from 'vue-sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { CLASS_WEEKS, downloadText, fileNameFrom, rowsToCsv, rowsToIcs } from '@/lib/export';
import { filterLabels, groupSchedule, plural, timeRange } from '@/lib/format';

const props = defineProps({
  sources: { type: Array, default: () => [] },
  filters: { type: Object, default: null },
  // open from the start (the answer text does not repeat the rows)
  expanded: { type: Boolean, default: false },
});

const open = ref(props.expanded);
const labels = computed(() => filterLabels(props.filters));
// Exam sittings have a date; weekly classes have a day and a lecturer
const exams = computed(() => props.sources.some((row) => row.kind === 'exam'));
const summary = computed(() =>
  exams.value
    ? plural(props.sources.length, 'matching exam')
    : plural(props.sources.length, 'matching class', 'matching classes'),
);
const groups = computed(() => groupSchedule(props.sources));
const fileBase = computed(() => fileNameFrom(labels.value.join(' '), exams.value ? 'utg-exams' : 'utg-classes'));

function saveCalendar() {
  const { ics, count } = rowsToIcs(props.sources);
  if (!count) {
    toast.error('These rows have no day or date to put in a calendar.');
    return;
  }
  downloadText(`${fileBase.value}.ics`, ics, 'text/calendar');
  toast.success('Calendar file downloaded', {
    description: exams.value
      ? 'Open it to add the exams to your calendar.'
      : `Open it to add the classes to your calendar, repeating weekly for ${CLASS_WEEKS} weeks.`,
  });
}

function saveSpreadsheet() {
  downloadText(`${fileBase.value}.csv`, rowsToCsv(props.sources), 'text/csv');
}
</script>

<template>
  <Collapsible v-model:open="open" class="mt-3">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1.5">
      <CollapsibleTrigger
        class="group inline-flex h-7 items-center gap-1.5 rounded-md border bg-background px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <TableProperties class="size-3.5" aria-hidden="true" />
        {{ summary }}
        <ChevronRight class="size-3.5 transition-transform group-data-[state=open]:rotate-90" aria-hidden="true" />
      </CollapsibleTrigger>
      <template v-if="labels.length">
        <span class="sr-only">Searched for</span>
        <Badge v-for="label in labels" :key="label" variant="secondary" class="font-normal">{{ label }}</Badge>
      </template>
    </div>

    <CollapsibleContent>
      <div class="mt-2.5 overflow-hidden rounded-xl border" data-testid="schedule">
        <section v-for="(group, g) in groups" :key="group.label" :class="{ 'border-t': g > 0 }">
          <h3 class="bg-muted/50 px-3 py-1.5 text-xs font-medium text-muted-foreground">{{ group.label }}</h3>
          <ul>
            <li
              v-for="(row, i) in group.rows"
              :key="row.id ?? i"
              class="grid grid-cols-[5.75rem_minmax(0,1fr)] gap-x-3 border-t px-3 py-2 sm:grid-cols-[6.5rem_minmax(0,1fr)_minmax(0,11rem)]"
            >
              <p class="pt-px text-sm font-medium tabular-nums">{{ timeRange(row.start_time, row.end_time) || 'Time not set' }}</p>
              <div class="min-w-0">
                <p class="text-sm font-medium [overflow-wrap:anywhere]">{{ row.course_title || row.course_code }}</p>
                <p class="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                  {{ [row.course_title ? row.course_code : '', row.lecturer].filter(Boolean).join(' · ') }}
                </p>
              </div>
              <p class="col-start-2 text-xs text-muted-foreground [overflow-wrap:anywhere] sm:col-start-3 sm:pt-0.5 sm:text-right sm:text-sm">
                {{ row.venue || 'Venue not set' }}
              </p>
            </li>
          </ul>
        </section>
        <div class="flex flex-wrap gap-1 border-t bg-muted/30 px-1.5 py-1 print:hidden">
          <Button variant="ghost" size="sm" class="text-muted-foreground" @click="saveCalendar">
            <CalendarPlus aria-hidden="true" />
            Add to calendar
          </Button>
          <Button variant="ghost" size="sm" class="text-muted-foreground" @click="saveSpreadsheet">
            <SheetIcon aria-hidden="true" />
            Download spreadsheet
          </Button>
        </div>
      </div>
    </CollapsibleContent>
  </Collapsible>
</template>
