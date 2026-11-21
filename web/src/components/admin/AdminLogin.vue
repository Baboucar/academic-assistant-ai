<script setup>
import { ref } from 'vue';
import { CircleAlert, LoaderCircle, LockKeyhole } from '@lucide/vue';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAdmin } from '@/composables/useAdmin';

const { signIn } = useAdmin();

const user = ref('');
const pass = ref('');
const error = ref('');
const submitting = ref(false);

async function submit() {
  if (submitting.value) return;
  error.value = '';
  if (!user.value.trim() || !pass.value) {
    error.value = 'Enter the admin username and password.';
    return;
  }
  submitting.value = true;
  try {
    await signIn(user.value.trim(), pass.value);
  } catch (e) {
    if (e?.status === 401) error.value = 'That username or password is not right.';
    else error.value = e?.message || 'Could not sign in. Please try again.';
    pass.value = '';
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-full items-center justify-center px-4 py-10">
    <Card class="w-full max-w-sm">
      <CardHeader>
        <span class="mb-2 flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground" aria-hidden="true">
          <LockKeyhole class="size-4" />
        </span>
        <CardTitle class="text-base">Admin sign in</CardTitle>
        <CardDescription>Manage the timetable, calendar and notice files the assistant answers from.</CardDescription>
      </CardHeader>
      <CardContent>
        <form class="grid gap-4" novalidate @submit.prevent="submit">
          <div class="grid gap-1.5">
            <Label for="admin-user">Username</Label>
            <Input id="admin-user" v-model="user" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" :aria-invalid="!!error" />
          </div>
          <div class="grid gap-1.5">
            <Label for="admin-pass">Password</Label>
            <Input id="admin-pass" v-model="pass" name="password" type="password" autocomplete="current-password" :aria-invalid="!!error" />
          </div>
          <p v-if="error" class="flex items-start gap-2 text-sm text-destructive" role="alert">
            <CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {{ error }}
          </p>
          <Button type="submit" size="lg" :disabled="submitting">
            <LoaderCircle v-if="submitting" class="animate-spin" aria-hidden="true" />
            {{ submitting ? 'Signing in…' : 'Sign in' }}
          </Button>
          <p class="text-xs text-muted-foreground">
            The credentials are the ADMIN_USER and ADMIN_PASS set in <code class="font-mono">server/.env</code>.
          </p>
        </form>
      </CardContent>
    </Card>
  </div>
</template>
