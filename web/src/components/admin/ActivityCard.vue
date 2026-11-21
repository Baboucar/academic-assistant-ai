<script setup>
// What has been happening: the questions that got no answer (so the timetable
// or the aliases can be fixed), how much of the AI allowance questions use, and
// who changed what.
import { computed } from 'vue';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useAdmin } from '@/composables/useAdmin';
import { plural, timeAgo } from '@/lib/format';

const { questions, log } = useAdmin();

const OUTCOME = {
  not_found: { label: 'No match', hint: 'Understood, but nothing in the timetable matched' },
  not_understood: { label: 'Not understood', hint: 'The assistant could not tell what to look for' },
  error: { label: 'Failed', hint: 'Something went wrong, usually the AI model being unavailable' },
};
const ACTION = { upload: 'Uploaded', delete: 'Removed', reingest: 'Re-ingested', setting: 'Changed setting', alias: 'Course alias' };

const summary = computed(() => {
  const q = questions.value;
  if (!q || !q.questions) return null;
  const answered = (q.totals?.answered || 0) + (q.totals?.clarify || 0) + (q.totals?.chat || 0);
  return {
    questions: q.questions,
    answered: Math.round((answered / q.questions) * 100),
    perQuestion: (q.model_calls / q.questions).toFixed(1),
    cached: q.cached,
  };
});
const unanswered = computed(() => questions.value?.unanswered || []);
const when = (ms) => timeAgo(new Date(ms));
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle class="text-base">Activity</CardTitle>
      <CardDescription>The last 7 days. Questions are stored without the student who asked.</CardDescription>
    </CardHeader>
    <CardContent class="grid gap-6">
      <section aria-labelledby="unanswered-heading" class="grid gap-2">
        <h3 id="unanswered-heading" class="text-sm font-medium">Questions that got no answer</h3>
        <p v-if="summary" class="text-xs text-muted-foreground" data-testid="question-summary">
          {{ plural(summary.questions, 'question') }}, {{ summary.answered }}% answered ·
          {{ summary.perQuestion }} AI calls per question · {{ summary.cached }} answered from memory
        </p>
        <ul v-if="unanswered.length" class="divide-y rounded-lg border">
          <li v-for="q in unanswered" :key="`${q.outcome}:${q.question}`" class="flex items-start gap-3 px-3 py-2 text-sm">
            <div class="min-w-0 flex-1">
              <p class="[overflow-wrap:anywhere]">{{ q.question }}</p>
              <p class="text-xs text-muted-foreground">
                {{ q.times > 1 ? `Asked ${q.times} times, last ` : '' }}{{ when(q.last_at) }}
              </p>
            </div>
            <Badge variant="secondary" class="shrink-0 font-normal" :title="OUTCOME[q.outcome]?.hint">
              {{ OUTCOME[q.outcome]?.label || q.outcome }}
            </Badge>
          </li>
        </ul>
        <p v-else class="text-sm text-muted-foreground">
          {{ questions ? 'Every question in the last 7 days got an answer.' : 'Nothing to show yet.' }}
        </p>
      </section>

      <section aria-labelledby="changes-heading" class="grid gap-2">
        <h3 id="changes-heading" class="text-sm font-medium">Recent changes</h3>
        <ul v-if="log.length" class="divide-y rounded-lg border">
          <li v-for="(entry, i) in log" :key="i" class="px-3 py-2 text-sm">
            <p class="[overflow-wrap:anywhere]">
              <span class="font-medium">{{ entry.admin }}</span>
              <span class="text-muted-foreground"> · {{ ACTION[entry.action] || entry.action }}</span>
              {{ entry.target }}
            </p>
            <p class="text-xs text-muted-foreground [overflow-wrap:anywhere]">
              {{ entry.detail ? `${entry.detail} · ` : '' }}{{ when(entry.at) }}
            </p>
          </li>
        </ul>
        <p v-else class="text-sm text-muted-foreground">No changes recorded yet.</p>
      </section>
    </CardContent>
  </Card>
</template>
