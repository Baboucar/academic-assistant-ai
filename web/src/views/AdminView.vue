<script setup>
import { computed, ref } from 'vue';
import { LoaderCircle, LogOut, RefreshCw } from '@lucide/vue';
import { toast } from 'vue-sonner';
import ActivityCard from '@/components/admin/ActivityCard.vue';
import AdminLogin from '@/components/admin/AdminLogin.vue';
import SettingsCard from '@/components/admin/SettingsCard.vue';
import SourcesTable from '@/components/admin/SourcesTable.vue';
import UploadCard from '@/components/admin/UploadCard.vue';
import { Button } from '@/components/ui/button';
import { useAdmin } from '@/composables/useAdmin';
import { plural } from '@/lib/format';

const { creds, counts, sources, signOut, reingest } = useAdmin();

const stats = computed(() => [
  { label: 'Files', value: sources.value.length },
  { label: 'Timetable classes', value: counts.value.timetable },
  { label: 'Exams', value: counts.value.exams },
  { label: 'Calendar events', value: counts.value.calendar },
  { label: 'Notices', value: counts.value.notices },
]);

const reingesting = ref(false);
async function reingestAll() {
  if (reingesting.value) return;
  reingesting.value = true;
  try {
    await reingest('');
    toast.success('Re-ingested everything in the data folder', {
      description: `${plural(counts.value.timetable, 'timetable class', 'timetable classes')} loaded.`,
    });
  } catch (e) {
    toast.error('Re-ingest did not finish', { description: e?.message, duration: 10000 });
  } finally {
    reingesting.value = false;
  }
}
</script>

<template>
  <div class="h-full overflow-y-auto">
    <AdminLogin v-if="!creds" />

    <div v-else class="mx-auto grid w-full max-w-5xl gap-6 px-4 py-6 sm:py-8">
      <div class="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 class="text-xl font-semibold tracking-tight">Admin</h1>
          <p class="text-sm text-muted-foreground">Signed in as {{ creds.user }}</p>
        </div>
        <div class="flex gap-2">
          <Button variant="outline" :disabled="reingesting" @click="reingestAll">
            <LoaderCircle v-if="reingesting" class="animate-spin" aria-hidden="true" />
            <RefreshCw v-else aria-hidden="true" />
            {{ reingesting ? 'Re-ingesting…' : 'Re-ingest all' }}
          </Button>
          <Button variant="ghost" @click="signOut">
            <LogOut aria-hidden="true" />
            Sign out
          </Button>
        </div>
      </div>

      <dl class="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border ring-1 ring-foreground/10 sm:grid-cols-5">
        <div v-for="stat in stats" :key="stat.label" class="bg-card px-4 py-3 first:col-span-2 sm:first:col-span-1">
          <dt class="text-xs text-muted-foreground">{{ stat.label }}</dt>
          <dd class="mt-1 text-2xl font-semibold tabular-nums tracking-tight">{{ stat.value }}</dd>
        </div>
      </dl>

      <SourcesTable />
      <UploadCard />
      <div class="grid items-start gap-6 lg:grid-cols-2">
        <SettingsCard />
        <ActivityCard />
      </div>
    </div>
  </div>
</template>
