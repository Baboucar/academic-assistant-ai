<script setup>
// Student sign-in, sign-up (with an emailed code) and password reset, as one card
// that moves between steps.
import { computed, nextTick, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { CircleAlert, GraduationCap, LoaderCircle, MailCheck } from '@lucide/vue';
import { toast } from 'vue-sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { getHealth } from '@/api';
import { useAuth } from '@/composables/useAuth';

const auth = useAuth();
const route = useRoute();
const router = useRouter();

// 'signin' | 'signup' | 'code' | 'forgot' | 'reset'
const step = ref(route.query.mode === 'signup' ? 'signup' : 'signin');
const form = ref({ identifier: '', mat: '', email: '', password: '', code: '' });
const error = ref('');
const submitting = ref(false);
const resending = ref(false);
// Only ever set on a local test server with no email set up (DEV_SHOW_CODES)
const devCode = ref('');

// Which email addresses the server accepts, for the hint under the field
const domains = ref(['utg.edu']);
onMounted(async () => {
  try {
    const health = await getHealth();
    if (Array.isArray(health.email_domains) && health.email_domains.length) domains.value = health.email_domains;
  } catch {
    // offline: submitting will say so
  }
});
const domainHint = computed(() => domains.value.map((d) => `@${d}`).join(' or '));

const COPY = {
  signin: { title: 'Sign in', description: 'Use your university email or matriculation number.', submit: 'Sign in', busy: 'Signing in…' },
  signup: { title: 'Create your account', description: 'For UTG students. You will confirm your email with a code.', submit: 'Create account', busy: 'Creating account…' },
  code: { title: 'Check your email', description: '', submit: 'Confirm email', busy: 'Checking…' },
  forgot: { title: 'Reset your password', description: 'We will email you a code to choose a new password.', submit: 'Email me a code', busy: 'Sending…' },
  reset: { title: 'Choose a new password', description: '', submit: 'Save new password', busy: 'Saving…' },
};
const copy = computed(() => COPY[step.value]);

function go(next) {
  step.value = next;
  error.value = '';
  form.value.code = '';
  devCode.value = '';
  if (next === 'forgot' || next === 'reset') form.value.password = '';
  nextTick(() => document.querySelector('[data-autofocus]')?.focus());
}

function done() {
  const next = typeof route.query.next === 'string' && route.query.next.startsWith('/') ? route.query.next : '/';
  router.replace(next);
}

function validate() {
  const f = form.value;
  const email = f.email.trim().toLowerCase();
  if (step.value === 'signin') {
    if (!f.identifier.trim() || !f.password) return 'Enter your email or matriculation number, and your password.';
  }
  if (step.value === 'signup') {
    if (!f.mat.trim()) return 'Enter your matriculation number.';
    if (!domains.value.includes(email.split('@')[1])) return `Use your ${domainHint.value} email address.`;
    if (f.password.length < 8) return 'Use at least 8 characters for the password.';
  }
  if (step.value === 'forgot' && !email.includes('@')) return 'Enter the email address of your account.';
  if ((step.value === 'code' || step.value === 'reset') && f.code.replace(/\D/g, '').length !== 6) {
    return 'Enter the 6-digit code from the email.';
  }
  if (step.value === 'reset' && f.password.length < 8) return 'Use at least 8 characters for the password.';
  return '';
}

async function submit() {
  if (submitting.value) return;
  error.value = validate();
  if (error.value) return;

  const f = form.value;
  const email = f.email.trim().toLowerCase();
  submitting.value = true;
  try {
    if (step.value === 'signin') {
      await auth.signIn(f.identifier.trim(), f.password);
      done();
    } else if (step.value === 'signup') {
      const sent = await auth.register({ mat_number: f.mat.trim(), email, password: f.password });
      f.email = email; // show the address as it was sent
      go('code');
      devCode.value = sent?.dev_code || '';
    } else if (step.value === 'code') {
      await auth.verify(email, f.code);
      done();
    } else if (step.value === 'forgot') {
      const sent = await auth.forgot(email);
      go('reset');
      devCode.value = sent?.dev_code || '';
    } else if (step.value === 'reset') {
      await auth.resetPassword(email, f.code, f.password);
      done();
    }
  } catch (e) {
    if (step.value === 'signin' && e?.data?.needs_verification) {
      // right password, but the email was never confirmed: a fresh code is on its way
      f.email = e.data.email || '';
      go('code');
      devCode.value = e.data.dev_code || '';
    } else {
      error.value = e?.message || 'Something went wrong. Please try again.';
    }
  } finally {
    submitting.value = false;
  }
}

async function resend() {
  if (resending.value) return;
  resending.value = true;
  error.value = '';
  try {
    const email = form.value.email.trim().toLowerCase();
    const sent = step.value === 'reset' ? await auth.forgot(email) : await auth.resend(email);
    devCode.value = sent?.dev_code || devCode.value;
    toast.success('A new code is on its way.');
  } catch (e) {
    error.value = e?.message || 'Could not send a new code. Please try again.';
  } finally {
    resending.value = false;
  }
}
</script>

<template>
  <div class="flex min-h-full flex-col items-center justify-center px-4 py-10">
    <div class="mb-6 flex items-center gap-2.5">
      <span class="flex size-9 items-center justify-center rounded-xl bg-primary text-primary-foreground" aria-hidden="true">
        <GraduationCap class="size-5" />
      </span>
      <span class="text-base font-semibold tracking-tight">UTG Academic Assistant</span>
    </div>

    <Card class="w-full max-w-sm">
      <CardHeader>
        <span
          v-if="step === 'code' || step === 'reset'"
          class="mb-2 flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground"
          aria-hidden="true"
        >
          <MailCheck class="size-4" />
        </span>
        <CardTitle class="text-base"><h1>{{ copy.title }}</h1></CardTitle>
        <CardDescription>
          <template v-if="step === 'code' || step === 'reset'">
            We sent a 6-digit code to <span class="font-medium text-foreground [overflow-wrap:anywhere]">{{ form.email }}</span>.
            It works for 15 minutes.
          </template>
          <template v-else>{{ copy.description }}</template>
        </CardDescription>
      </CardHeader>

      <CardContent>
        <form class="grid gap-4" novalidate @submit.prevent="submit">
          <div v-if="step === 'signin'" class="grid gap-1.5">
            <Label for="auth-identifier">Email or matriculation number</Label>
            <Input
              id="auth-identifier" v-model="form.identifier" data-autofocus name="username" autocomplete="username"
              autocapitalize="none" spellcheck="false" :aria-invalid="!!error"
            />
          </div>

          <template v-if="step === 'signup'">
            <div class="grid gap-1.5">
              <Label for="auth-mat">Matriculation number</Label>
              <Input
                id="auth-mat" v-model="form.mat" data-autofocus name="mat_number" autocomplete="off"
                autocapitalize="characters" spellcheck="false" inputmode="text"
              />
            </div>
            <div class="grid gap-1.5">
              <Label for="auth-email">University email</Label>
              <Input
                id="auth-email" v-model="form.email" name="email" type="email" autocomplete="email"
                autocapitalize="none" spellcheck="false" :placeholder="`you@${domains[0]}`" aria-describedby="auth-email-hint"
              />
              <p id="auth-email-hint" class="text-xs text-muted-foreground">Must end in {{ domainHint }}.</p>
            </div>
          </template>

          <div v-if="step === 'forgot'" class="grid gap-1.5">
            <Label for="auth-forgot-email">University email</Label>
            <Input
              id="auth-forgot-email" v-model="form.email" data-autofocus name="email" type="email" autocomplete="email"
              autocapitalize="none" spellcheck="false"
            />
          </div>

          <div v-if="step === 'code' || step === 'reset'" class="grid gap-1.5">
            <Label for="auth-code">6-digit code</Label>
            <Input
              id="auth-code" v-model="form.code" data-autofocus name="code" inputmode="numeric" autocomplete="one-time-code"
              maxlength="7" class="text-center font-mono text-lg tracking-[0.4em]" :aria-invalid="!!error"
            />
          </div>

          <div v-if="step === 'signin' || step === 'signup' || step === 'reset'" class="grid gap-1.5">
            <div class="flex items-center justify-between">
              <Label for="auth-password">{{ step === 'reset' ? 'New password' : 'Password' }}</Label>
              <button
                v-if="step === 'signin'" type="button"
                class="rounded-sm text-xs text-muted-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                @click="go('forgot')"
              >
                Forgot password?
              </button>
            </div>
            <Input
              id="auth-password" v-model="form.password" name="password" type="password"
              :autocomplete="step === 'signin' ? 'current-password' : 'new-password'"
              :aria-describedby="step === 'signin' ? undefined : 'auth-password-hint'"
            />
            <p v-if="step !== 'signin'" id="auth-password-hint" class="text-xs text-muted-foreground">At least 8 characters.</p>
          </div>

          <p
            v-if="devCode && (step === 'code' || step === 'reset')"
            class="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
            data-testid="dev-code"
          >
            Test mode: email is not set up on this server, so no email was sent. Your code is
            <span class="font-mono text-sm font-semibold text-foreground">{{ devCode }}</span>
          </p>

          <p v-if="error" class="flex items-start gap-2 text-sm text-destructive" role="alert">
            <CircleAlert class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{{ error }}</span>
          </p>

          <Button type="submit" size="lg" :disabled="submitting">
            <LoaderCircle v-if="submitting" class="animate-spin" aria-hidden="true" />
            {{ submitting ? copy.busy : copy.submit }}
          </Button>

          <div class="text-center text-sm text-muted-foreground">
            <template v-if="step === 'signin'">
              New here?
              <button type="button" class="font-medium text-foreground underline underline-offset-4" @click="go('signup')">Create an account</button>
            </template>
            <template v-else-if="step === 'signup' || step === 'forgot'">
              Already have an account?
              <button type="button" class="font-medium text-foreground underline underline-offset-4" @click="go('signin')">Sign in</button>
            </template>
            <template v-else>
              No email?
              <button type="button" class="font-medium text-foreground underline underline-offset-4" :disabled="resending" @click="resend">
                {{ resending ? 'Sending…' : 'Send a new code' }}
              </button>
              <span aria-hidden="true"> · </span>
              <button type="button" class="font-medium text-foreground underline underline-offset-4" @click="go(step === 'code' ? 'signup' : 'forgot')">
                Change email
              </button>
            </template>
          </div>
        </form>
      </CardContent>
    </Card>
  </div>
</template>
